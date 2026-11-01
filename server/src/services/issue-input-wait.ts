import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { lockIssueCloseoutGraph } from "./issue-closeout.js";
import { persistActivity, type ActivityPublication } from "./activity-log.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueThreadInteractions, issues } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { issueTreeControlService } from "./issue-tree-control.js";

/** Form-required and execution-required are distinct; old wake questions retain their wait semantics. */
export function interactionBlocksWork(interaction: {
  kind: string; continuationPolicy: string; payload: unknown;
}) {
  if (interaction.kind !== "ask_user_questions") return false;
  const payload = interaction.payload as { blocksWork?: boolean; questions?: { required?: boolean }[] };
  if (typeof payload?.blocksWork === "boolean") return payload.blocksWork;
  return interaction.continuationPolicy !== "none" &&
    (payload?.questions ?? []).some((question) => question.required !== false);
}

export function requiredInputCondition() {
  return sql`${issueThreadInteractions.kind} = 'ask_user_questions'
    and ${issueThreadInteractions.status} = 'pending'
    and ((${issueThreadInteractions.payload}->>'blocksWork') = 'true'
      or (not (${issueThreadInteractions.payload} ? 'blocksWork')
        and ${issueThreadInteractions.continuationPolicy} <> 'none'
        and exists (select 1 from jsonb_array_elements(${issueThreadInteractions.payload}->'questions') q
          where coalesce(q->>'required', 'true') <> 'false')))`;
}

export async function listRequiredInputs(db: Db, companyId: string, issueId: string) {
  return db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    requiredInputCondition(),
  )).orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
}

export async function hasRequiredInput(db: Db, companyId: string, issueId: string) {
  return (await listRequiredInputs(db, companyId, issueId)).length > 0;
}

export async function assertNoRequiredInput(db: Db, companyId: string, issueId: string) {
  const pending = await listRequiredInputs(db, companyId, issueId);
  if (pending.length) throw conflict("Issue is waiting for required input", {
    code: "issue_waiting_for_input", interactionIds: pending.map((row) => row.id),
  });
}

export async function lockInputIssue(db: Db, companyId: string, issueId: string) {
  await lockIssueCloseoutGraph(db, companyId);
  return db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .for("update").then((rows) => rows[0] ?? null);
}

function ownsWait(issue: typeof issues.$inferSelect) {
  const receipt = issue.unblockDescriptor?.interactionWait;
  return receipt && issue.status === "blocked" && receipt.statusVersion === issue.statusVersion &&
    receipt.assigneeAgentId === issue.assigneeAgentId && receipt.assigneeUserId === issue.assigneeUserId;
}

/** Caller holds the issue row lock; creation, resolution and work-start arbitration use the same lock order. */
export async function synchronizeIssueInputWait(db: Db, companyId: string, issueId: string, options: { onRestored?: (key: string, issue: typeof issues.$inferSelect) => void; restore?: boolean; activityPublications?: ActivityPublication[]; addressedInteractions?: (typeof issueThreadInteractions.$inferSelect)[]; actor?: { agentId?: string | null; userId?: string | null; runId?: string | null } } = {}) {
  const issue = await lockInputIssue(db, companyId, issueId);
  if (!issue || issue.status === "done" || issue.status === "cancelled") return issue;
  const pending = await listRequiredInputs(db, companyId, issueId);
  const owned = ownsWait(issue);
  const now = new Date();
  for (const interaction of pending) {
    if (interaction.addresseeAgentId || interaction.addresseeUserId || !interaction.createdByAgentId) continue;
    const creator = await db.select({ reportsTo: agents.reportsTo }).from(agents).where(and(
      eq(agents.id, interaction.createdByAgentId), eq(agents.companyId, companyId),
    )).then((rows) => rows[0] ?? null);
    if (!creator?.reportsTo) continue;
    const manager = await db.select().from(agents).where(and(eq(agents.id, creator.reportsTo), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!manager || !(await evaluateAgentInvokabilityFromDb(db, manager)).invokable ||
      !issueThreadInteractionAttentionAgentAllowed({ agentId: manager.id, interaction })) continue;
    await db.update(issueThreadInteractions).set({ addresseeAgentId: manager.id, updatedAt: now })
      .where(and(eq(issueThreadInteractions.id, interaction.id), eq(issueThreadInteractions.status, "pending")));
    interaction.addresseeAgentId = manager.id;
    options.addressedInteractions?.push(interaction);
    const { publication } = await persistActivity(db, { companyId, actorType: "system", actorId: "required-input",
      agentId: interaction.createdByAgentId, runId: interaction.sourceRunId,
      action: "issue.thread_interaction_addressed", entityType: "issue", entityId: issueId,
      details: { interactionId: interaction.id, addresseeAgentId: manager.id, source: "required_input_reconciliation" } });
    options.activityPublications?.push(publication);
  }
  if (pending.length) {
    // Existing review/manual blockers retain their authority and restoration policy.
    if (!owned && (!["in_progress", "todo"].includes(issue.status) || issue.unblockDescriptor ||
      (!issue.assigneeAgentId && !issue.assigneeUserId))) return issue;
    const first = pending[0];
    const owner = first.addresseeAgentId ? { agentId: first.addresseeAgentId }
      : first.addresseeUserId ? { userId: first.addresseeUserId } : "board" as const;
    const descriptor: IssueUnblockDescriptor = {
      owner,
      action: `Resolve required input: ${first.title ?? first.id}`,
      interactionWait: {
        statusVersion: owned ? issue.statusVersion : issue.statusVersion + 1,
        continuationKey: owned ? issue.unblockDescriptor!.interactionWait!.continuationKey : first.id,
        assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        interactionIds: pending.map((row) => row.id),
      },
    };
    const { issueService } = await import("./issues.js");
    const updated = owned
      ? await db.update(issues).set({ unblockDescriptor: descriptor, updatedAt: now })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).returning().then((rows) => rows[0])
      : await issueService(db).update(issueId, { status: "blocked", unblockDescriptor: descriptor, companyGuard: companyId },
        db, options.activityPublications, undefined, { preserveExecutionForInputWait: true });
    if (!owned) {
      const { publication } = await persistActivity(db, {
      companyId, actorType: "system", actorId: "required-input", action: "issue.input_wait_started",
      runId: first.sourceRunId, agentId: first.createdByAgentId,
      entityType: "issue", entityId: issueId,
      details: { interactionIds: descriptor.interactionWait!.interactionIds, status: "blocked", _previous: { status: issue.status } },
      });
      options.activityPublications?.push(publication);
    }
    return updated;
  }
  if (!owned) return issue;
  if (options.restore === false) {
    await db.update(issues).set({
      unblockDescriptor: { owner: issue.unblockDescriptor!.owner, action: "Required input skipped; provide replacement instructions before continuing" }, updatedAt: now,
    }).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    return issue;
  }
  // Resolving a question does not discharge independent dependency or pause gates.
  const { issueService } = await import("./issues.js");
  const readiness = (await issueService(db).listDependencyReadiness(companyId, [issueId])).get(issueId);
  const pause = await issueTreeControlService(db).getActivePauseHoldGate(companyId, issueId);
  const executor = issue.assigneeAgentId ? await db.select().from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, issue.assigneeAgentId))).then((rows) => rows[0] ?? null) : null;
  const invokability = executor ? await evaluateAgentInvokabilityFromDb(db, executor) : null;
  const budget = executor ? await budgetService(db).getInvocationBlock(companyId, executor.id, { issueId, projectId: issue.projectId }) : null;
  if (readiness?.isDependencyReady === false || pause || invokability?.invokable === false || budget) {
    const descriptor = invokability?.invokable === false || budget ? {
      owner: issue.unblockDescriptor!.owner,
      action: "Required input answered; restore executor availability before continuing",
    } : null;
    await db.update(issues).set({ unblockDescriptor: descriptor, updatedAt: now })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    return issue;
  }
  const updated = await issueService(db).update(issueId, { status: "in_progress", unblockDescriptor: null, companyGuard: companyId },
    db, options.activityPublications);
  if (updated) options.onRestored?.(issue.unblockDescriptor!.interactionWait!.continuationKey, updated);
  if (updated) {
    const actor = options.actor;
    const { publication } = await persistActivity(db, {
    companyId, actorType: actor?.userId ? "user" : actor?.agentId ? "agent" : "system",
    actorId: actor?.userId ?? actor?.agentId ?? "required-input", action: "issue.input_wait_resolved",
    agentId: actor?.agentId, runId: actor?.runId,
    entityType: "issue", entityId: issueId,
    details: { interactionIds: issue.unblockDescriptor!.interactionWait!.interactionIds, status: "in_progress", _previous: { status: "blocked" } },
    });
    options.activityPublications?.push(publication);
  }
  return updated ?? issue;
}


/** A resolved wait is permission only for the exact owner and disposition it restored. */
export function inputWaitContinuationIsCurrent(result: unknown, issue: {
  status: string; statusVersion?: number; assigneeAgentId: string | null; assigneeUserId?: string | null;
}) {
  const claim = result as { workContinuationKey?: string | false; workContinuationStatusVersion?: number;
    workContinuationAssigneeAgentId?: string | null; workContinuationAssigneeUserId?: string | null };
  if (claim?.workContinuationKey === false) return false;
  if (typeof claim?.workContinuationKey !== "string") return true;
  return issue.status === "in_progress" && claim.workContinuationStatusVersion === issue.statusVersion &&
    claim.workContinuationAssigneeAgentId === issue.assigneeAgentId &&
    claim.workContinuationAssigneeUserId === (issue.assigneeUserId ?? null);
}


export function inputWaitContinuationReceipt(result: unknown) {
  const claim = result as Record<string, unknown> | null;
  if (typeof claim?.workContinuationKey !== "string") return null;
  return { workContinuationKey: claim.workContinuationKey,
    workContinuationStatusVersion: claim.workContinuationStatusVersion,
    workContinuationAssigneeAgentId: claim.workContinuationAssigneeAgentId,
    workContinuationAssigneeUserId: claim.workContinuationAssigneeUserId };
}
