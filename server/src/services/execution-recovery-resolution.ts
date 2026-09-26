import { randomUUID } from "node:crypto";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
  type ExecutionReconciliationContinuationDelivery,
  type ExecutionReconciliationDisposition,
  type ExecutionReconciliationResult,
  type IssueRecoveryAction,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import {
  executionReconciliationIdempotencyKey,
  legacyExecutionReconciliationIdempotencyKey,
} from "./execution-reconciliation-identity.js";

const EXECUTION_RECONCILIATION_ACTION_OUTCOMES = new Set([
  "completed",
  "not_performed",
  "mixed",
] as const);
const EXECUTION_RECONCILIATION_CONTINUATION_DELIVERIES = new Set([
  "pending",
  "delegated",
  "delivered",
  "invalidated",
] as const);

export function persistedExecutionReconciliation(
  action: Pick<IssueRecoveryAction, "evidence">,
): ExecutionReconciliation | null {
  const value = action.evidence.executionReconciliation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.runId !== "string" ||
    record.providerStopped !== true ||
    typeof record.actionOutcome !== "string" ||
    !EXECUTION_RECONCILIATION_ACTION_OUTCOMES.has(
      record.actionOutcome as ExecutionReconciliation["actionOutcome"],
    ) ||
    typeof record.outcomeEvidence !== "string"
  ) {
    return null;
  }
  return {
    runId: record.runId,
    providerStopped: true,
    actionOutcome:
      record.actionOutcome as ExecutionReconciliation["actionOutcome"],
    outcomeEvidence: record.outcomeEvidence,
  };
}

export function executionReconciliationMatches(
  persisted: ExecutionReconciliation,
  submitted: ExecutionReconciliation,
): boolean {
  return (
    persisted.runId === submitted.runId &&
    persisted.providerStopped === submitted.providerStopped &&
    persisted.actionOutcome === submitted.actionOutcome &&
    persisted.outcomeEvidence === submitted.outcomeEvidence
  );
}

export function executionReconciliationResult(
  action: Pick<IssueRecoveryAction, "evidence">,
  decision: ExecutionReconciliation,
  disposition: ExecutionReconciliationDisposition,
): ExecutionReconciliationResult {
  const continuationDelivery = action.evidence.continuationDelivery;
  if (
    typeof continuationDelivery !== "string" ||
    !EXECUTION_RECONCILIATION_CONTINUATION_DELIVERIES.has(
      continuationDelivery as ExecutionReconciliationContinuationDelivery,
    )
  ) {
    throw new Error(
      "Persisted execution reconciliation is missing its continuation delivery state",
    );
  }
  return {
    disposition,
    actionOutcome: decision.actionOutcome,
    continuationDelivery:
      continuationDelivery as ExecutionReconciliationContinuationDelivery,
    replayStarted: false,
  };
}

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.runId !== input.sourceRunId || !agentId) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  if (
    !run ||
    !task ||
    task.assigneeAgentId !== agentId ||
    (run.agentId !== agentId && !isCurrentReviewer) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  for (const pid of [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string },
) {
  if (deliveryOwner) {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  const recordedAt = new Date().toISOString();
  const recordedDecision = {
    ...decision,
    actorId,
    recordedAt,
  };
  const siblings = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.sourceIssueId, action.sourceIssueId),
        ne(issueRecoveryActions.id, action.id),
        sql`${issueRecoveryActions.evidence}->>'runId' = ${decision.runId}`,
        or(
          sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
          sql`${issueRecoveryActions.evidence}->>'continuationDelivery' in ('pending', 'delivered')`,
        ),
      ),
    )
    .for("update");
  for (const sibling of siblings) {
    const siblingDecision = persistedExecutionReconciliation(sibling);
    if (
      siblingDecision &&
      !executionReconciliationMatches(siblingDecision, decision)
    ) {
      throw conflict(
        "This execution already has a different reconciliation decision.",
        { code: "execution_reconciliation_conflict" },
      );
    }
    if (sibling.evidence.continuationDelivery === "delivered") {
      throw conflict(
        "This execution already has a linked continuation. Inspect that run first.",
        { code: "execution_reconciliation_already_delivered" },
      );
    }
    if (sibling.evidence.continuationDelivery === "pending") {
      const [existingDelivery] = await db
        .select({ runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, action.companyId),
            ne(agentWakeupRequests.status, "skipped"),
            sql`${agentWakeupRequests.payload}->>'recoveryActionId' = ${sibling.id}`,
          ),
        )
        .limit(1);
      if (existingDelivery?.runId) {
        throw conflict(
          "This execution already has a linked continuation. Inspect that run first.",
          { code: "execution_reconciliation_already_delivered" },
        );
      }
    }
  }

  await db
    .update(nativeRunFinalizations)
    .set({
      failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.companyId, action.companyId),
        eq(nativeRunFinalizations.runId, decision.runId),
      ),
    );
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: {
        ...action.evidence,
        automaticRecovery: undefined,
        executionReconciliation: recordedDecision,
        continuationDelivery: deliveryOwner ? "delegated" : "pending",
        ...(deliveryOwner ? { continuationDeliveryOwner: deliveryOwner } : {}),
      },
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
      ),
    );

  for (const sibling of siblings) {
    const { automaticRecovery: _automaticRecovery, ...siblingEvidence } =
      sibling.evidence;
    await db
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "cancelled",
        resolutionNote:
          "Duplicate recovery record invalidated by the source run's reconciliation decision.",
        nextAction:
          "Duplicate hold cleared. Continuation delivery is owned by the canonical source-run reconciliation.",
        resolvedAt: sibling.resolvedAt ?? new Date(recordedAt),
        updatedAt: new Date(recordedAt),
        evidence: {
          ...siblingEvidence,
          executionReconciliation: recordedDecision,
          continuationDelivery: "invalidated",
          duplicateOfRecoveryActionId: action.id,
          duplicateInvalidatedAt: recordedAt,
        },
      })
      .where(
        and(
          eq(issueRecoveryActions.companyId, action.companyId),
          eq(issueRecoveryActions.id, sibling.id),
        ),
      );
    await persistActivity(db, {
      companyId: action.companyId,
      actorType: "system",
      actorId: "execution-recovery",
      action: "issue.execution_recovery_duplicate_invalidated",
      entityType: "issue",
      entityId: action.sourceIssueId,
      runId: decision.runId,
      details: {
        recoveryActionId: sibling.id,
        canonicalRecoveryActionId: action.id,
        sourceRunId: decision.runId,
      },
    });
  }
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
) {
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .orderBy(asc(issueRecoveryActions.createdAt), asc(issueRecoveryActions.id))
    .limit(25);
  for (const action of pending) {
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const sourceRunKey = executionReconciliationIdempotencyKey(
        action.companyId,
        decision.runId,
      );
      const legacyRunKey = legacyExecutionReconciliationIdempotencyKey(
        action.id,
      );
      const [legacyReceipt] = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, action.companyId),
            eq(agentWakeupRequests.agentId, action.returnOwnerAgentId),
            eq(agentWakeupRequests.idempotencyKey, legacyRunKey),
            ne(agentWakeupRequests.status, "skipped"),
          ),
        )
        .limit(1);
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: legacyReceipt ? legacyRunKey : sourceRunKey,
        payload: { issueId: task.id, recoveryActionId: action.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          recoveryActionId: action.id,
          previousRunId: decision.runId,
          retryOfRunId: decision.runId,
          forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored",
          source: "execution.reconciled",
        },
      });
      if (run)
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: decision.runId })
            .where(
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
                sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
              ),
            );
          await tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
                {
                  continuationDelivery: "delivered",
                  continuationRunId: run.id,
                },
              )}::jsonb`,
            })
            .where(pendingDecision);
        });
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold obsolete conversation holds without waking historical work on upgrade.
  // Keep their evidence and record the policy change in the task's activity log.
  const obsoleteConversationHold = and(
    conversationRecoveryActionPredicate(),
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence: sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: { recoveryActionId: action.id, outcome: "cancelled", continuation: "conversation" },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        inArray(issueRecoveryActions.cause, [
          ...EXECUTION_RECONCILIATION_CAUSES,
        ]),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
      ),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !EXECUTION_RECONCILIATION_CAUSES.includes(
            action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number],
          ) ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const [sameRunRecoveryOwner] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(
            and(
              eq(issueRecoveryActions.companyId, action.companyId),
              eq(issueRecoveryActions.sourceIssueId, action.sourceIssueId),
              ne(issueRecoveryActions.id, action.id),
              sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
              or(
                sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
                sql`${issueRecoveryActions.evidence}->>'continuationDelivery' in ('pending', 'delivered')`,
              ),
            ),
          )
          .orderBy(
            sql`case when ${issueRecoveryActions.evidence}->>'continuationDelivery' in ('pending', 'delivered') then 0 else 1 end`,
            asc(issueRecoveryActions.createdAt),
          )
          .limit(1)
          .for("update");
        const current =
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        if (sameRunRecoveryOwner) {
          const continuationOwned = ["pending", "delivered"].includes(
            String(sameRunRecoveryOwner.evidence.continuationDelivery),
          );
          if (current) {
            await tx
              .update(issues)
              .set({
                ...(continuationOwned ? {} : { status: "blocked" as const }),
                executionRunId: null,
                checkoutRunId: null,
                updatedAt: now,
              })
              .where(eq(issues.id, task.id));
          }
          const { automaticRecovery: _automaticRecovery, ...candidateEvidence } =
            action.evidence;
          await tx
            .update(issueRecoveryActions)
            .set({
              status: "resolved",
              outcome: "cancelled",
              resolvedAt: now,
              updatedAt: now,
              nextAction:
                "Duplicate source-run recovery record folded into its canonical owner.",
              resolutionNote:
                "A recovery record for the same stopped execution already owns reconciliation and continuation delivery.",
              wakePolicy: null,
              monitorPolicy: null,
              evidence: {
                ...candidateEvidence,
                duplicateOfRecoveryActionId: sameRunRecoveryOwner.id,
                duplicateInvalidatedAt: now.toISOString(),
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
          await persistActivity(tx as unknown as Db, {
            companyId: run.companyId,
            actorType: "system",
            actorId: "execution-recovery",
            action: "issue.execution_recovery_duplicate_invalidated",
            entityType: "issue",
            entityId: task.id,
            runId: run.id,
            details: {
              recoveryActionId: action.id,
              canonicalRecoveryActionId: sameRunRecoveryOwner.id,
              sourceRunId: run.id,
              phase: "automatic_settlement",
            },
          });
          await tx
            .update(heartbeatRuns)
            .set({ executionStatusDeliveryId: randomUUID() })
            .where(eq(heartbeatRuns.id, run.id));
          return;
        }
        const note = current
          ? "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked" && run.runtimeMode === "native") {
            nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              automaticRecovery: {
                policy: "preserve_without_replay_v1",
                runId: run.id,
                replay: "blocked",
                actionOutcome: "unknown",
                recordedAt: now.toISOString(),
              },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: "not_authorized",
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: "preserve_without_replay_v1",
            replay: "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
}
