import { createHash } from "node:crypto";
import { Command } from "commander";
import type {
  CreateIssueThreadInteraction,
  HeartbeatRun,
  Issue,
  IssueThreadInteraction,
  ResolveIssueRecoveryActionResponse,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

const OPEN_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

export type DeterministicNonAdmissionReason =
  | "stale_queued_review_gate"
  | "gateway_connection_refused";

export interface StewardReconciliationInspection {
  issue: Issue;
  run: HeartbeatRun | null;
  activeRun: HeartbeatRun | null;
  pendingHumanInteractionIds: string[];
  classification:
    | "eligible_verified_non_admission"
    | "human_gate"
    | "active_execution"
    | "terminal_receipt_requires_judgement"
    | "unsettled_requires_judgement"
    | "invalid_hold";
  reason: string;
  deterministicReason?: DeterministicNonAdmissionReason;
}

interface StewardReconcileOptions extends BaseClientOptions {
  apply?: boolean;
  maxActions?: string;
  identifiers?: string;
}

interface StewardAttentionOptions extends BaseClientOptions {
  apply?: boolean;
  attentionIssue: string;
}

interface StewardReconcileAction {
  identifier: string;
  issueId: string;
  runId: string | null;
  action: "would_reconcile" | "reconciled" | "skipped" | "failed";
  classification: StewardReconciliationInspection["classification"];
  reason: string;
  sourceIssueStatus?: "todo" | "in_review" | "blocked";
  recoveryActionId?: string;
  continuationDelivery?: string;
}

interface StewardReconcileReport {
  schema: "paperclip.steward_reconciliation.v1";
  mode: "dry_run" | "apply";
  companyId: string;
  scannedAt: string;
  scannedIssueCount: number;
  heldIssueCount: number;
  eligibleCount: number;
  appliedCount: number;
  failedCount: number;
  actions: StewardReconcileAction[];
}

export interface StewardAttentionCase {
  identifier: string;
  issueId: string;
  title: string;
  status: string;
  classification:
    | "terminal_receipt_requires_judgement"
    | "unsettled_requires_judgement"
    | "invalid_hold"
    | "blocked_state_requires_attention"
    | "review_state_requires_attention";
  reason: string;
  runId: string | null;
  recoveryActionId: string | null;
  updatedAt: string;
}

interface StewardAttentionReport {
  schema: "paperclip.steward_attention.v1";
  mode: "dry_run" | "apply";
  companyId: string;
  scannedAt: string;
  scannedIssueCount: number;
  heldIssueCount: number;
  attentionCaseCount: number;
  humanGateCount: number;
  fingerprint: string | null;
  interactionId: string | null;
  action:
    | "none"
    | "would_notify"
    | "notified"
    | "pending_unchanged"
    | "acknowledged_unchanged"
    | "would_clear"
    | "cleared"
    | "failed";
  supersededInteractionIds: string[];
  reason: string;
  cases: StewardAttentionCase[];
}

const ATTENTION_IDEMPOTENCY_PREFIX = "factory-recovery-attention:v1:";
const ATTENTION_CLASSIFICATIONS = new Set<
  StewardReconciliationInspection["classification"]
>([
  "terminal_receipt_requires_judgement",
  "unsettled_requires_judgement",
  "invalid_hold",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireResponse<T>(value: T | null, description: string): T {
  if (value === null) {
    throw new Error(`Paperclip returned an empty response for ${description}.`);
  }
  return value;
}

function hasTerminalProviderSettlement(run: HeartbeatRun): boolean {
  const settlement = record(run.resultJson?.providerSettlement);
  return settlement?.state === "terminal";
}

export function classifyDeterministicNonAdmission(
  run: HeartbeatRun,
): DeterministicNonAdmissionReason | null {
  if (
    run.lastUsefulActionAt != null ||
    run.usageJson != null ||
    hasTerminalProviderSettlement(run)
  ) {
    return null;
  }

  if (
    run.startedAt == null &&
    run.errorCode === "issue_continuation_waiting_on_review" &&
    run.resultJson?.stopReason === "issue_continuation_waiting_on_review" &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate"
  ) {
    return "stale_queued_review_gate";
  }

  if (
    run.errorCode === "openclaw_gateway_request_failed" &&
    run.resultJson?.stopReason === "adapter_failed" &&
    typeof run.error === "string" &&
    /^connect ECONNREFUSED(?:\s|$)/.test(run.error)
  ) {
    return "gateway_connection_refused";
  }

  return null;
}

function parseMaxActions(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "5", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new Error("--max-actions must be an integer between 1 and 25");
  }
  return parsed;
}

function selectedIdentifiers(value: string | undefined): Set<string> | null {
  if (!value?.trim()) return null;
  const identifiers = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (identifiers.length === 0) return null;
  return new Set(identifiers);
}

function attentionCase(
  inspection: StewardReconciliationInspection,
): StewardAttentionCase | null {
  if (!ATTENTION_CLASSIFICATIONS.has(inspection.classification)) return null;
  return {
    identifier: inspection.issue.identifier ?? inspection.issue.id,
    issueId: inspection.issue.id,
    title: inspection.issue.title,
    status: inspection.issue.status,
    classification:
      inspection.classification as StewardAttentionCase["classification"],
    reason: inspection.reason,
    runId: inspection.run?.id ?? inspection.issue.executionBlocker?.runId ?? null,
    recoveryActionId:
      inspection.issue.executionBlocker?.recoveryActionId ?? null,
    updatedAt: String(inspection.issue.updatedAt),
  };
}

async function uncoveredBoardAttentionCase(
  ctx: ResolvedClientContext,
  issue: Issue,
): Promise<{ item: StewardAttentionCase | null; humanGate: boolean }> {
  const blockerNeedsAttention =
    issue.status === "blocked" &&
    issue.blockerAttention?.state === "needs_attention";
  const reviewNeedsAttention =
    issue.status === "in_review" && issue.reviewAttention?.state === "stalled";
  if (!blockerNeedsAttention && !reviewNeedsAttention) {
    return { item: null, humanGate: false };
  }

  const [freshIssue, activeRun, interactions] = await Promise.all([
    ctx.api.get<Issue>(apiPath`/api/issues/${issue.id}`),
    ctx.api.get<HeartbeatRun | null>(apiPath`/api/issues/${issue.id}/active-run`),
    ctx.api.get<IssueThreadInteraction[]>(
      apiPath`/api/issues/${issue.id}/interactions`,
    ),
  ]);
  const presentIssue = requireResponse(freshIssue, `issue ${issue.id}`);
  if (presentIssue.executionBlocker) {
    return { item: null, humanGate: false };
  }
  const freshBlockerNeedsAttention =
    presentIssue.status === "blocked" &&
    presentIssue.blockerAttention?.state === "needs_attention";
  const freshReviewNeedsAttention =
    presentIssue.status === "in_review" &&
    presentIssue.reviewAttention?.state === "stalled";
  if (!freshBlockerNeedsAttention && !freshReviewNeedsAttention) {
    return { item: null, humanGate: false };
  }
  const hasPendingHuman = (interactions ?? []).some(isPendingHumanInteraction);
  if (hasPendingHuman) return { item: null, humanGate: true };
  if (activeRun && ["queued", "running"].includes(activeRun.status)) {
    return { item: null, humanGate: false };
  }

  const classification = freshBlockerNeedsAttention
    ? "blocked_state_requires_attention"
    : "review_state_requires_attention";
  return {
    item: {
      identifier: presentIssue.identifier ?? presentIssue.id,
      issueId: presentIssue.id,
      title: presentIssue.title,
      status: presentIssue.status,
      classification,
      reason: freshBlockerNeedsAttention
        ? "Paperclip marks this blocked state as needing attention, with no active run or pending human-only interaction covering it."
        : "Paperclip marks this review state as needing attention, with no active run or pending human-only interaction covering it.",
      runId: null,
      recoveryActionId: null,
      updatedAt: String(presentIssue.updatedAt),
    },
    humanGate: false,
  };
}

export function stewardAttentionFingerprint(
  cases: StewardAttentionCase[],
): string | null {
  if (cases.length === 0) return null;
  const canonical = [...cases]
    .sort((a, b) => a.identifier.localeCompare(b.identifier))
    .map((item) => ({
      issueId: item.issueId,
      status: item.status,
      classification: item.classification,
      runId: item.runId,
      recoveryActionId: item.recoveryActionId,
      updatedAt: item.updatedAt,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function classificationLabel(
  classification: StewardAttentionCase["classification"],
): string {
  if (classification === "terminal_receipt_requires_judgement") {
    return "terminal provider receipt; task outcome needs judgement";
  }
  if (classification === "unsettled_requires_judgement") {
    return "provider outcome is ambiguous or unsettled";
  }
  if (classification === "blocked_state_requires_attention") {
    return "blocked state has no maintained action path";
  }
  if (classification === "review_state_requires_attention") {
    return "review state has no maintained action path";
  }
  return "execution hold is structurally incomplete";
}

function issueHref(item: StewardAttentionCase): string {
  const companyKey = item.identifier.includes("-")
    ? item.identifier.split("-", 1)[0]
    : null;
  return companyKey
    ? `/${encodeURIComponent(companyKey)}/issues/${encodeURIComponent(item.identifier)}`
    : `/issues/${encodeURIComponent(item.issueId)}`;
}

export function buildStewardAttentionInteraction(
  attentionIssue: Issue,
  cases: StewardAttentionCase[],
  fingerprint: string,
  humanGateCount: number,
): CreateIssueThreadInteraction {
  const sorted = [...cases].sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
  const details = [
    "These issues remain fenced because the control plane cannot safely infer the task outcome. Review the linked record and choose its explicit recovery disposition; acknowledgement of this digest does not change any source issue.",
    "",
    ...sorted.map(
      (item) =>
        `- [${item.identifier}](${issueHref(item)}) · **${item.status}** · ${classificationLabel(item.classification)} · ${item.title}`,
    ),
    ...(humanGateCount > 0
      ? [
          "",
          `${humanGateCount} additional issue${humanGateCount === 1 ? " has" : "s have"} an existing pending human-only interaction and ${humanGateCount === 1 ? "is" : "are"} not duplicated here.`,
        ]
      : []),
  ].join("\n");
  return {
    kind: "request_confirmation",
    idempotencyKey: `${ATTENTION_IDEMPOTENCY_PREFIX}${fingerprint}`,
    title: `Recovery attention: ${cases.length} fenced case${cases.length === 1 ? "" : "s"}`,
    summary:
      "A deterministic board scan found recovery holds that require operator judgement. No work was replayed and no gate was weakened.",
    resolverPolicy: "human_only",
    continuationPolicy: "none",
    ...(attentionIssue.responsibleUserId
      ? { addresseeUserId: attentionIssue.responsibleUserId }
      : {}),
    payload: {
      version: 1,
      prompt: `Review ${cases.length} fenced recovery case${cases.length === 1 ? "" : "s"}, then acknowledge this digest.`,
      acceptLabel: "Acknowledge",
      rejectLabel: "Dismiss",
      rejectRequiresReason: false,
      allowDeclineReason: false,
      detailsMarkdown: details,
      supersedeOnUserComment: false,
    },
  };
}

function isPendingHumanInteraction(interaction: IssueThreadInteraction): boolean {
  return (
    interaction.status === "pending" &&
    interaction.effectiveResolverPolicy === "human_only"
  );
}

async function inspectHeldIssue(
  ctx: ResolvedClientContext,
  issueRef: string,
): Promise<StewardReconciliationInspection | null> {
  const issue = requireResponse(
    await ctx.api.get<Issue>(apiPath`/api/issues/${issueRef}`),
    `issue ${issueRef}`,
  );
  const blocker = issue.executionBlocker;
  if (!blocker) return null;

  const [activeRun, interactions] = await Promise.all([
    ctx.api.get<HeartbeatRun | null>(apiPath`/api/issues/${issue.id}/active-run`),
    ctx.api.get<IssueThreadInteraction[]>(apiPath`/api/issues/${issue.id}/interactions`),
  ]);
  const pendingHumanInteractionIds = (interactions ?? [])
    .filter(isPendingHumanInteraction)
    .map((interaction) => interaction.id);

  if (activeRun && ["queued", "running"].includes(activeRun.status)) {
    return {
      issue,
      run: null,
      activeRun,
      pendingHumanInteractionIds,
      classification: "active_execution",
      reason: `Issue already has ${activeRun.status} run ${activeRun.id}; no reconciliation mutation is safe.`,
    };
  }

  if (!blocker.runId || !blocker.recoveryActionId) {
    return {
      issue,
      run: null,
      activeRun,
      pendingHumanInteractionIds,
      classification: "invalid_hold",
      reason: "Execution blocker does not identify both a source run and recovery action.",
    };
  }

  const run = requireResponse(
    await ctx.api.get<HeartbeatRun>(apiPath`/api/heartbeat-runs/${blocker.runId}`),
    `heartbeat run ${blocker.runId}`,
  );
  if (pendingHumanInteractionIds.length > 0) {
    return {
      issue,
      run,
      activeRun,
      pendingHumanInteractionIds,
      classification: "human_gate",
      reason: `Pending human-only interaction(s) ${pendingHumanInteractionIds.join(", ")} must remain authoritative.`,
    };
  }

  if (hasTerminalProviderSettlement(run)) {
    return {
      issue,
      run,
      activeRun,
      pendingHumanInteractionIds,
      classification: "terminal_receipt_requires_judgement",
      reason:
        "The provider is terminal, but deterministic evidence cannot classify the task outcome as completed, mixed, or not performed.",
    };
  }

  const deterministicReason = classifyDeterministicNonAdmission(run);
  if (deterministicReason) {
    return {
      issue,
      run,
      activeRun,
      pendingHumanInteractionIds,
      classification: "eligible_verified_non_admission",
      deterministicReason,
      reason:
        deterministicReason === "stale_queued_review_gate"
          ? "Run was rejected by the stale queued-review gate before provider admission, with no usage or useful action."
          : "OpenClaw gateway connection was refused before provider admission, with no usage or useful action.",
    };
  }

  return {
    issue,
    run,
    activeRun,
    pendingHumanInteractionIds,
    classification: "unsettled_requires_judgement",
    reason:
      "No terminal provider receipt or deterministic pre-admission signature is present; keep the no-replay fence.",
  };
}

function resolutionDisposition(inspection: StewardReconciliationInspection): {
  outcome: "restored" | "blocked";
  sourceIssueStatus: "todo" | "in_review" | "blocked";
} {
  const hasUnresolvedIssueBlocker =
    inspection.issue.blockedBy?.some(
      (blocker) => !["done", "cancelled"].includes(blocker.status),
    ) ?? false;
  if (inspection.issue.status === "blocked" && hasUnresolvedIssueBlocker) {
    return { outcome: "blocked", sourceIssueStatus: "blocked" };
  }
  if (inspection.issue.status === "in_review") {
    return { outcome: "restored", sourceIssueStatus: "in_review" };
  }
  return { outcome: "restored", sourceIssueStatus: "todo" };
}

function outcomeEvidence(inspection: StewardReconciliationInspection): string {
  const run = inspection.run!;
  const signature =
    inspection.deterministicReason === "stale_queued_review_gate"
      ? `startedAt=null, errorCode=${run.errorCode}, stopReason=${String(run.resultJson?.stopReason)}, timeoutSource=${String(run.resultJson?.timeoutSource)}`
      : `errorCode=${run.errorCode}, stopReason=${String(run.resultJson?.stopReason)}, error=${run.error}`;
  return `Deterministic reconciliation for run ${run.id}: ${signature}; usageJson=null, lastUsefulActionAt=null, providerSettlement absent. The provider was verified not admitted, so actionOutcome is not_performed. Continuation is deliberately deferred for separate owner review.`;
}

async function listOpenIssues(
  ctx: ResolvedClientContext,
  companyId: string,
): Promise<Issue[]> {
  const params = new URLSearchParams({
    status: "todo,in_progress,in_review,blocked",
    excludeRoutineExecutions: "true",
    limit: "1000",
    sortField: "id",
    sortDir: "asc",
  });
  const issues =
    (await ctx.api.get<Issue[]>(
      `${apiPath`/api/companies/${companyId}/issues`}?${params.toString()}`,
    )) ?? [];
  return issues.filter((issue) => OPEN_STATUSES.has(issue.status));
}

async function withdrawAttentionInteraction(
  ctx: ResolvedClientContext,
  attentionIssueId: string,
  interactionId: string,
  reason: string,
): Promise<void> {
  await ctx.api.post(
    apiPath`/api/issues/${attentionIssueId}/interactions/${interactionId}/reject`,
    { reason },
  );
}

export function registerStewardCommands(program: Command): void {
  const steward = program
    .command("steward")
    .description("Deterministic board stewardship without model execution");

  addCommonClientOptions(
    steward
      .command("reconcile")
      .description(
        "Inspect execution holds and optionally clear only deterministic pre-admission failures without dispatching successors",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--apply", "Apply eligible reconciliations; default is dry-run")
      .option("--max-actions <n>", "Maximum reconciliations to apply", "5")
      .option(
        "--identifiers <csv>",
        "Restrict inspection to specific issue identifiers",
      )
      .action(async (opts: StewardReconcileOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = ctx.companyId!;
          const maxActions = parseMaxActions(opts.maxActions);
          const selected = selectedIdentifiers(opts.identifiers);
          const openIssues = (await listOpenIssues(ctx, companyId)).filter(
            (issue) =>
              !selected ||
              (issue.identifier != null && selected.has(issue.identifier.toUpperCase())),
          );
          const inspections: StewardReconciliationInspection[] = [];
          for (const issue of openIssues) {
            const inspection = await inspectHeldIssue(ctx, issue.id);
            if (inspection) inspections.push(inspection);
          }

          const actions: StewardReconcileAction[] = inspections.map((inspection) => ({
            identifier: inspection.issue.identifier ?? inspection.issue.id,
            issueId: inspection.issue.id,
            runId: inspection.run?.id ?? inspection.issue.executionBlocker?.runId ?? null,
            action:
              inspection.classification === "eligible_verified_non_admission"
                ? "would_reconcile"
                : "skipped",
            classification: inspection.classification,
            reason: inspection.reason,
            recoveryActionId:
              inspection.issue.executionBlocker?.recoveryActionId ?? undefined,
          }));

          if (opts.apply) {
            let attempted = 0;
            for (const action of actions) {
              if (
                action.classification !== "eligible_verified_non_admission" ||
                attempted >= maxActions
              ) {
                continue;
              }

              const inspection = await inspectHeldIssue(ctx, action.issueId);
              if (
                !inspection ||
                inspection.classification !== "eligible_verified_non_admission" ||
                inspection.run?.id !== action.runId
              ) {
                action.action = "skipped";
                action.reason =
                  "Live state changed after planning; no mutation was attempted.";
                continue;
              }

              const blocker = inspection.issue.executionBlocker!;
              const disposition = resolutionDisposition(inspection);
              action.sourceIssueStatus = disposition.sourceIssueStatus;
              attempted += 1;
              try {
                const result = requireResponse(
                  await ctx.api.post<ResolveIssueRecoveryActionResponse>(
                    apiPath`/api/issues/${inspection.issue.id}/recovery-actions/resolve`,
                    {
                      actionId: blocker.recoveryActionId,
                      outcome: disposition.outcome,
                      sourceIssueStatus: disposition.sourceIssueStatus,
                      continuationPolicy: "manual",
                      resolutionNote:
                        "Deterministic steward verified that the historical run never reached the provider. The execution fence is cleared without dispatching successor work.",
                      executionReconciliation: {
                        runId: inspection.run.id,
                        providerStopped: true,
                        providerAdmission: "verified_not_admitted",
                        actionOutcome: "not_performed",
                        outcomeEvidence: outcomeEvidence(inspection),
                      },
                    },
                  ),
                  `recovery action ${blocker.recoveryActionId}`,
                );
                const [verifiedIssue, verifiedActiveRun] = await Promise.all([
                  ctx.api.get<Issue>(apiPath`/api/issues/${inspection.issue.id}`),
                  ctx.api.get<HeartbeatRun | null>(
                    apiPath`/api/issues/${inspection.issue.id}/active-run`,
                  ),
                ]);
                const presentVerifiedIssue = requireResponse(
                  verifiedIssue,
                  `post-reconciliation issue ${inspection.issue.id}`,
                );
                const delivery =
                  result.executionReconciliationResult?.continuationDelivery;
                if (
                  presentVerifiedIssue.executionBlocker ||
                  verifiedActiveRun ||
                  delivery !== "not_required"
                ) {
                  throw new Error(
                    `Postcondition failed: executionBlocker=${Boolean(presentVerifiedIssue.executionBlocker)}, activeRun=${verifiedActiveRun?.id ?? "none"}, continuationDelivery=${delivery ?? "missing"}`,
                  );
                }
                action.action = "reconciled";
                action.reason =
                  "Verified non-admission was recorded; the hold is clear and no successor was dispatched.";
                action.continuationDelivery = delivery;
              } catch (error) {
                action.action = "failed";
                action.reason =
                  error instanceof Error ? error.message : String(error);
              }
            }
          }

          const report: StewardReconcileReport = {
            schema: "paperclip.steward_reconciliation.v1",
            mode: opts.apply ? "apply" : "dry_run",
            companyId,
            scannedAt: new Date().toISOString(),
            scannedIssueCount: openIssues.length,
            heldIssueCount: inspections.length,
            eligibleCount: inspections.filter(
              (inspection) =>
                inspection.classification === "eligible_verified_non_admission",
            ).length,
            appliedCount: actions.filter((action) => action.action === "reconciled")
              .length,
            failedCount: actions.filter((action) => action.action === "failed")
              .length,
            actions,
          };
          printOutput(report, { json: ctx.json });
          if (report.failedCount > 0) process.exitCode = 1;
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    steward
      .command("attention")
      .description(
        "Create one de-duplicated human digest for fenced recovery cases that require outcome judgement",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption(
        "--attention-issue <id>",
        "Stable open issue used to host the operator digest",
      )
      .option("--apply", "Create or retire the digest; default is dry-run")
      .action(async (opts: StewardAttentionOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = ctx.companyId!;
          const [openIssues, attentionIssue] = await Promise.all([
            listOpenIssues(ctx, companyId),
            ctx.api.get<Issue>(apiPath`/api/issues/${opts.attentionIssue}`),
          ]);
          const presentAttentionIssue = requireResponse(
            attentionIssue,
            `attention issue ${opts.attentionIssue}`,
          );
          if (presentAttentionIssue.companyId !== companyId) {
            throw new Error("The attention issue belongs to a different company.");
          }
          if (["done", "cancelled"].includes(presentAttentionIssue.status)) {
            throw new Error("The attention issue must remain open.");
          }

          const inspections: StewardReconciliationInspection[] = [];
          for (const issue of openIssues) {
            if (issue.id === presentAttentionIssue.id) continue;
            const inspection = await inspectHeldIssue(ctx, issue.id);
            if (inspection) inspections.push(inspection);
          }
          const cases = inspections
            .map(attentionCase)
            .filter((item): item is StewardAttentionCase => item !== null);
          let humanGateCount = inspections.filter(
            (inspection) => inspection.classification === "human_gate",
          ).length;
          const inspectedIssueIds = new Set(
            inspections.map((inspection) => inspection.issue.id),
          );
          for (const issue of openIssues) {
            if (
              issue.id === presentAttentionIssue.id ||
              inspectedIssueIds.has(issue.id)
            ) {
              continue;
            }
            const uncovered = await uncoveredBoardAttentionCase(ctx, issue);
            if (uncovered.item) cases.push(uncovered.item);
            if (uncovered.humanGate) humanGateCount += 1;
          }
          cases.sort((a, b) => a.identifier.localeCompare(b.identifier));
          const fingerprint = stewardAttentionFingerprint(cases);
          const interactions =
            (await ctx.api.get<IssueThreadInteraction[]>(
              apiPath`/api/issues/${presentAttentionIssue.id}/interactions`,
            )) ?? [];
          const ownedInteractions = interactions.filter((interaction) =>
            interaction.idempotencyKey?.startsWith(
              ATTENTION_IDEMPOTENCY_PREFIX,
            ),
          );
          const currentKey = fingerprint
            ? `${ATTENTION_IDEMPOTENCY_PREFIX}${fingerprint}`
            : null;
          const current = currentKey
            ? ownedInteractions.find(
                (interaction) => interaction.idempotencyKey === currentKey,
              ) ?? null
            : null;
          const stalePending = ownedInteractions.filter(
            (interaction) =>
              interaction.status === "pending" &&
              interaction.idempotencyKey !== currentKey,
          );

          const report: StewardAttentionReport = {
            schema: "paperclip.steward_attention.v1",
            mode: opts.apply ? "apply" : "dry_run",
            companyId,
            scannedAt: new Date().toISOString(),
            scannedIssueCount: openIssues.length,
            heldIssueCount: inspections.length,
            attentionCaseCount: cases.length,
            humanGateCount,
            fingerprint,
            interactionId: current?.id ?? null,
            action: "none",
            supersededInteractionIds: [],
            reason: "No operator digest is required.",
            cases,
          };

          if (cases.length === 0) {
            if (stalePending.length === 0) {
              report.reason = "No judgement cases or stale pending digest exist.";
            } else if (!opts.apply) {
              report.action = "would_clear";
              report.reason = `${stalePending.length} stale pending digest interaction(s) would be withdrawn.`;
            } else {
              for (const interaction of stalePending) {
                await withdrawAttentionInteraction(
                  ctx,
                  presentAttentionIssue.id,
                  interaction.id,
                  "No fenced recovery case currently requires judgement.",
                );
                report.supersededInteractionIds.push(interaction.id);
              }
              report.action = "cleared";
              report.reason =
                "Stale digest withdrawn because no judgement cases remain.";
            }
          } else if (current) {
            if (opts.apply) {
              for (const interaction of stalePending) {
                await withdrawAttentionInteraction(
                  ctx,
                  presentAttentionIssue.id,
                  interaction.id,
                  "Superseded by the current deterministic recovery-attention digest.",
                );
                report.supersededInteractionIds.push(interaction.id);
              }
            }
            report.action =
              current.status === "pending"
                ? "pending_unchanged"
                : "acknowledged_unchanged";
            report.reason =
              current.status === "pending"
                ? "The current digest is already pending; no duplicate was created."
                : "The current digest was already acknowledged; unchanged cases remain suppressed.";
          } else if (!opts.apply) {
            report.action = "would_notify";
            report.reason = "A changed recovery-case set would create one human-only digest.";
          } else {
            try {
              const created = requireResponse(
                await ctx.api.post<IssueThreadInteraction>(
                  apiPath`/api/issues/${presentAttentionIssue.id}/interactions`,
                  buildStewardAttentionInteraction(
                    presentAttentionIssue,
                    cases,
                    fingerprint!,
                    humanGateCount,
                  ),
                ),
                "steward attention interaction",
              );
              report.interactionId = created.id;
              for (const interaction of stalePending) {
                await withdrawAttentionInteraction(
                  ctx,
                  presentAttentionIssue.id,
                  interaction.id,
                  "Superseded by a changed deterministic recovery-attention digest.",
                );
                report.supersededInteractionIds.push(interaction.id);
              }
              report.action = "notified";
              report.reason =
                "Created one human-only digest; source issues and recovery gates were not changed.";
            } catch (error) {
              report.action = "failed";
              report.reason = error instanceof Error ? error.message : String(error);
            }
          }

          printOutput(report, { json: ctx.json });
          if (report.action === "failed") process.exitCode = 1;
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: false },
  );
}
