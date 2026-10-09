import { Command } from "commander";
import type {
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
}
