import { createHash } from "node:crypto";
import { Command } from "commander";
import type {
  CreateIssueThreadInteraction,
  HeartbeatRun,
  Issue,
  IssueComment,
  IssueThreadInteraction,
  RequestItemVerdictsInteraction,
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
  pendingHumanInteractions: IssueThreadInteraction[];
  classification:
    | "eligible_verified_non_admission"
    | "human_gate"
    | "active_execution"
    | "terminal_receipt_requires_judgement"
    | "unsettled_requires_judgement"
    | "invalid_hold"
    | "blocked_state_requires_attention"
    | "review_state_requires_attention";
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

interface StewardApplyDecisionsOptions extends BaseClientOptions {
  apply?: boolean;
  attentionIssue: string;
  maxActions?: string;
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
  latestEvidence: string[];
  conflictingEvidence: string[];
  recommendedDisposition:
    | "mark_done"
    | "retry_requeue"
    | "remain_blocked"
    | "human_decision_required";
  confidence: "high" | "medium" | "low";
  authorityRequired: string;
  exactMutation: string;
  automaticRefusalReason: string;
  targetStatus: "todo" | "in_review" | "done" | "blocked" | null;
  proposalFingerprint: string;
}

export interface StewardExistingHumanGate {
  identifier: string;
  issueId: string;
  issueTitle: string;
  status: string;
  interactionId: string;
  interactionTitle: string;
  summary: string;
  prompt: string;
  acceptEffect: string;
  rejectEffect: string;
  href: string;
  updatedAt: string;
}

export interface StewardAttentionReport {
  schema: "paperclip.steward_attention.v2";
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
    | "decided_unchanged"
    | "would_clear"
    | "cleared"
    | "failed";
  supersededInteractionIds: string[];
  reason: string;
  cases: StewardAttentionCase[];
  existingHumanGates: StewardExistingHumanGate[];
}

interface StewardApplyDecisionAction {
  identifier: string;
  issueId: string;
  interactionId: string;
  itemId: string;
  recommendedDisposition: StewardAttentionCase["recommendedDisposition"];
  action:
    | "would_apply"
    | "applied"
    | "recorded_no_source_change"
    | "skipped"
    | "failed";
  reason: string;
  exactMutation: string;
}

export interface StewardApplyDecisionsReport {
  schema: "paperclip.steward_attention_apply.v1";
  mode: "dry_run" | "apply";
  companyId: string;
  scannedAt: string;
  approvedDecisionCount: number;
  mutationCandidateCount: number;
  appliedCount: number;
  failedCount: number;
  actions: StewardApplyDecisionAction[];
}

const LEGACY_ATTENTION_IDEMPOTENCY_PREFIX = "factory-recovery-attention:v1:";
const ATTENTION_IDEMPOTENCY_PREFIX = "factory-recovery-attention:v2:";
const ATTENTION_ITEM_ID_PREFIX = "steward:";
const COMMENT_EVIDENCE_LIMIT = 8;
const ATTENTION_CLASSIFICATIONS = new Set<string>([
  "terminal_receipt_requires_judgement",
  "unsettled_requires_judgement",
  "invalid_hold",
  "blocked_state_requires_attention",
  "review_state_requires_attention",
]);

function isAttentionClassification(
  value: StewardReconciliationInspection["classification"],
): value is StewardAttentionCase["classification"] {
  return ATTENTION_CLASSIFICATIONS.has(value);
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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error("--max-actions must be an integer between 1 and 5");
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

function compactEvidenceText(value: string, maxLength = 520): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function executionStateValue(issue: Issue, key: string): unknown {
  return record(issue.executionState)?.[key];
}

function providerSettlement(run: HeartbeatRun | null): Record<string, unknown> | null {
  return record(run?.resultJson?.providerSettlement);
}

function terminalProviderSucceeded(run: HeartbeatRun | null): boolean {
  const terminalStatus = providerSettlement(run)?.terminalStatus;
  return (
    typeof terminalStatus === "string" &&
    ["ok", "success", "succeeded", "completed"].includes(
      terminalStatus.toLowerCase(),
    )
  );
}

function unresolvedBlockerIdentifiers(issue: Issue): string[] {
  return (issue.blockedBy ?? [])
    .filter((blocker) => !["done", "cancelled"].includes(blocker.status))
    .map((blocker) => blocker.identifier ?? blocker.id);
}

const POSITIVE_EVIDENCE_PATTERN =
  /\b(approved|complete(?:d)?|done|fixed|healthy|pass(?:ed)?|succeeded|success)\b/i;
const CONTRADICTORY_EVIDENCE_PATTERN =
  /\b(blocked|changes requested|failed|failure|incomplete|not complete|pending|remain|insufficient|do not close|must not close|withheld)\b/i;

function commentEvidence(comments: IssueComment[]): {
  latestEvidence: string[];
  conflictingEvidence: string[];
} {
  const ordered = [...comments].sort(
    (a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
  );
  const selected = new Map<string, IssueComment>();
  if (ordered[0]) selected.set(ordered[0].id, ordered[0]);
  const latestPositive = ordered.find((comment) =>
    POSITIVE_EVIDENCE_PATTERN.test(comment.body),
  );
  const latestContradictory = ordered.find((comment) =>
    CONTRADICTORY_EVIDENCE_PATTERN.test(comment.body),
  );
  if (latestPositive) selected.set(latestPositive.id, latestPositive);
  if (latestContradictory) selected.set(latestContradictory.id, latestContradictory);
  for (const comment of ordered) {
    if (selected.size >= 3) break;
    selected.set(comment.id, comment);
  }
  const evidence = [...selected.values()]
    .sort(
      (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    )
    .map((comment) => {
      const author = comment.authorUserId
        ? "Human"
        : comment.authorAgentId || comment.derivedAuthorAgentId
          ? "Agent"
          : "System";
      return `${String(comment.createdAt)} · ${author}: ${compactEvidenceText(comment.body)}`;
    });
  const conflictingEvidence =
    latestPositive && latestContradictory && latestPositive.id !== latestContradictory.id
      ? [
          "Completion-like and blocking/rework statements both exist. A comment saying work is fixed or complete is not treated as proof, and the structured gate remains authoritative.",
        ]
      : [];
  return { latestEvidence: evidence, conflictingEvidence };
}

function structuredEvidence(
  inspection: StewardReconciliationInspection,
): string[] {
  const issue = inspection.issue;
  const run = inspection.run;
  const settlement = providerSettlement(run);
  const reviewStatus = executionStateValue(issue, "status");
  const reviewOutcome = executionStateValue(issue, "lastDecisionOutcome");
  const blockers = unresolvedBlockerIdentifiers(issue);
  const evidence = [
    `Issue record: status=${issue.status}; updatedAt=${String(issue.updatedAt)}.`,
  ];
  if (issue.executionBlocker) {
    evidence.push(
      `Execution fence: recoveryAction=${issue.executionBlocker.recoveryActionId ?? "missing"}; run=${issue.executionBlocker.runId ?? "missing"}; cause=${issue.executionBlocker.cause ?? "unspecified"}.`,
    );
  }
  if (run) {
    evidence.push(
      `Source run: id=${run.id}; status=${run.status}; providerSettlement=${String(settlement?.state ?? "absent")}; terminalStatus=${String(settlement?.terminalStatus ?? "absent")}; usage=${run.usageJson == null ? "absent" : "present"}; lastUsefulActionAt=${String(run.lastUsefulActionAt ?? "absent")}.`,
    );
  }
  if (reviewStatus != null || reviewOutcome != null) {
    evidence.push(
      `Structured review: status=${String(reviewStatus ?? "absent")}; lastDecisionOutcome=${String(reviewOutcome ?? "absent")}.`,
    );
  }
  if (blockers.length > 0) {
    evidence.push(`Unresolved first-class blockers: ${blockers.join(", ")}.`);
  }
  return evidence;
}

function proposalFingerprint(value: Omit<StewardAttentionCase, "proposalFingerprint">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        issueId: value.issueId,
        status: value.status,
        updatedAt: value.updatedAt,
        classification: value.classification,
        runId: value.runId,
        recoveryActionId: value.recoveryActionId,
        latestEvidence: value.latestEvidence,
        conflictingEvidence: value.conflictingEvidence,
        recommendedDisposition: value.recommendedDisposition,
        targetStatus: value.targetStatus,
        exactMutation: value.exactMutation,
      }),
    )
    .digest("hex");
}

export function deriveStewardAttentionCase(
  inspection: StewardReconciliationInspection,
  comments: IssueComment[] = [],
): StewardAttentionCase | null {
  if (!isAttentionClassification(inspection.classification)) return null;
  const issue = inspection.issue;
  const run = inspection.run;
  const blockers = unresolvedBlockerIdentifiers(issue);
  const reviewOutcome = executionStateValue(issue, "lastDecisionOutcome");
  const reviewStatus = executionStateValue(issue, "status");
  const evidence = commentEvidence(comments);
  const latestPositiveComment = comments.find((comment) =>
    POSITIVE_EVIDENCE_PATTERN.test(comment.body),
  );
  if (
    latestPositiveComment &&
    (reviewOutcome === "changes_requested" || blockers.length > 0)
  ) {
    evidence.conflictingEvidence.push(
      "A completion-like comment conflicts with authoritative structured review or blocker state. The structured state wins, and the issue cannot be marked Done.",
    );
  }

  let recommendedDisposition: StewardAttentionCase["recommendedDisposition"];
  let confidence: StewardAttentionCase["confidence"];
  let targetStatus: StewardAttentionCase["targetStatus"];
  let automaticRefusalReason: string;

  if (blockers.length > 0) {
    recommendedDisposition = "remain_blocked";
    confidence = "high";
    targetStatus = "blocked";
    automaticRefusalReason = `Unresolved first-class blocker${blockers.length === 1 ? "" : "s"}: ${blockers.join(", ")}.`;
  } else if (inspection.classification === "unsettled_requires_judgement") {
    recommendedDisposition = "remain_blocked";
    confidence = "high";
    targetStatus = "blocked";
    automaticRefusalReason =
      "The provider outcome is not authoritatively settled. Retrying or closing could duplicate unknown work.";
  } else if (inspection.classification === "invalid_hold") {
    recommendedDisposition = "remain_blocked";
    confidence = "low";
    targetStatus = "blocked";
    automaticRefusalReason =
      "The recovery hold is structurally incomplete, so there is no exact run/action pair that can be safely reconciled.";
  } else if (inspection.classification === "blocked_state_requires_attention") {
    recommendedDisposition = "retry_requeue";
    confidence = "medium";
    targetStatus = "todo";
    automaticRefusalReason =
      "The issue has no active run, pending human gate, execution hold, or unresolved first-class blocker. Requeueing changes ownership state and therefore requires an explicit governed decision.";
  } else if (inspection.classification === "review_state_requires_attention") {
    recommendedDisposition = "retry_requeue";
    confidence = "medium";
    targetStatus = "in_review";
    automaticRefusalReason =
      "The review path is stalled. A reviewer retry is a governed execution decision and is never inferred from a comment.";
  } else if (
    terminalProviderSucceeded(run) &&
    reviewOutcome === "approved" &&
    reviewStatus === "completed" &&
    evidence.conflictingEvidence.length === 0
  ) {
    recommendedDisposition = "mark_done";
    confidence = "high";
    targetStatus = "done";
    automaticRefusalReason =
      "Completion has structured terminal-provider and independent-review evidence, but changing the source to Done remains an explicit governed mutation.";
  } else if (reviewOutcome === "changes_requested") {
    recommendedDisposition = "retry_requeue";
    confidence = "high";
    targetStatus = "todo";
    automaticRefusalReason =
      "The latest structured review decision is changes_requested. Completion claims in comments cannot override it.";
  } else {
    recommendedDisposition = "retry_requeue";
    confidence = terminalProviderSucceeded(run) ? "medium" : "high";
    targetStatus = issue.status === "in_review" ? "in_review" : "todo";
    automaticRefusalReason = terminalProviderSucceeded(run)
      ? "The provider succeeded, but task completion and any required independent review are not both established."
      : "The terminal provider receipt does not establish that the task outcome is complete.";
  }

  const recoveryActionId = issue.executionBlocker?.recoveryActionId ?? null;
  const runId = run?.id ?? issue.executionBlocker?.runId ?? null;
  let exactMutation: string;
  let authorityRequired: string;
  if (recommendedDisposition === "mark_done") {
    exactMutation = recoveryActionId
      ? `After a fresh state check, resolve recovery action ${recoveryActionId} for run ${runId} as restored, record actionOutcome=completed from its terminal receipt, set ${issue.identifier ?? issue.id} to Done, retain the assignee, use manual continuation, and create no successor run.`
      : `After a fresh state check, set ${issue.identifier ?? issue.id} to Done and retain the assignee. No run is started.`;
    authorityRequired =
      "Board operator, with the existing independent-review approval still current.";
  } else if (recommendedDisposition === "retry_requeue") {
    exactMutation = recoveryActionId
      ? `After a fresh state check, resolve recovery action ${recoveryActionId} for run ${runId} as restored, record actionOutcome=mixed from its terminal receipt, set ${issue.identifier ?? issue.id} to ${targetStatus}, retain the assignee, use manual continuation, and create no successor run.`
      : `After a fresh state check, set ${issue.identifier ?? issue.id} to ${targetStatus}, retain the assignee, and add an audited steward comment. The steward does not request a wake or start a run.`;
    authorityRequired =
      "Board operator to approve the displayed state change; the existing assignee/reviewer retains execution authority.";
  } else {
    exactMutation =
      "No source issue, recovery action, run, assignee, blocker, or review state changes. The verdict is recorded only on the AND-996 review card.";
    authorityRequired =
      "Human judgement only; no source-mutation authority is exercised.";
  }

  const withoutFingerprint: Omit<StewardAttentionCase, "proposalFingerprint"> = {
    identifier: issue.identifier ?? issue.id,
    issueId: issue.id,
    title: issue.title,
    status: issue.status,
    classification:
      inspection.classification as StewardAttentionCase["classification"],
    reason: inspection.reason,
    runId,
    recoveryActionId,
    updatedAt: String(issue.updatedAt),
    latestEvidence: [
      ...structuredEvidence(inspection),
      ...evidence.latestEvidence,
    ],
    conflictingEvidence: evidence.conflictingEvidence,
    recommendedDisposition,
    confidence,
    authorityRequired,
    exactMutation,
    automaticRefusalReason,
    targetStatus,
  };
  return {
    ...withoutFingerprint,
    proposalFingerprint: proposalFingerprint(withoutFingerprint),
  };
}

async function uncoveredBoardAttentionCase(
  ctx: ResolvedClientContext,
  issue: Issue,
): Promise<{
  inspection: StewardReconciliationInspection | null;
  pendingHumanInteractions: IssueThreadInteraction[];
}> {
  const blockerNeedsAttention =
    issue.status === "blocked" &&
    issue.blockerAttention?.state === "needs_attention";
  const reviewNeedsAttention =
    issue.status === "in_review" && issue.reviewAttention?.state === "stalled";
  if (!blockerNeedsAttention && !reviewNeedsAttention) {
    return { inspection: null, pendingHumanInteractions: [] };
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
    return { inspection: null, pendingHumanInteractions: [] };
  }
  const freshBlockerNeedsAttention =
    presentIssue.status === "blocked" &&
    presentIssue.blockerAttention?.state === "needs_attention";
  const freshReviewNeedsAttention =
    presentIssue.status === "in_review" &&
    presentIssue.reviewAttention?.state === "stalled";
  if (!freshBlockerNeedsAttention && !freshReviewNeedsAttention) {
    return { inspection: null, pendingHumanInteractions: [] };
  }
  const pendingHumanInteractions = (interactions ?? []).filter(
    isPendingHumanInteraction,
  );
  if (pendingHumanInteractions.length > 0) {
    return { inspection: null, pendingHumanInteractions };
  }
  if (activeRun && ["queued", "running"].includes(activeRun.status)) {
    return { inspection: null, pendingHumanInteractions: [] };
  }

  const classification = freshBlockerNeedsAttention
    ? "blocked_state_requires_attention"
    : "review_state_requires_attention";
  return {
    inspection: {
      issue: presentIssue,
      run: null,
      activeRun,
      pendingHumanInteractionIds: [],
      pendingHumanInteractions: [],
      classification,
      reason: freshBlockerNeedsAttention
        ? "Paperclip marks this blocked state as needing attention, with no active run or pending human-only interaction covering it."
        : "Paperclip marks this review state as needing attention, with no active run or pending human-only interaction covering it.",
    },
    pendingHumanInteractions: [],
  };
}

export function stewardAttentionFingerprint(
  cases: StewardAttentionCase[],
  existingHumanGates: StewardExistingHumanGate[] = [],
): string | null {
  if (cases.length === 0) return null;
  const canonical = {
    cases: [...cases]
      .sort((a, b) => a.identifier.localeCompare(b.identifier))
      .map((item) => ({
        issueId: item.issueId,
        proposalFingerprint: item.proposalFingerprint,
      })),
    existingHumanGates: [...existingHumanGates]
      .sort((a, b) => a.interactionId.localeCompare(b.interactionId))
      .map((gate) => ({
        issueId: gate.issueId,
        interactionId: gate.interactionId,
        updatedAt: gate.updatedAt,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function issueHref(
  item: Pick<StewardAttentionCase, "identifier" | "issueId">,
): string {
  const companyKey = item.identifier.includes("-")
    ? item.identifier.split("-", 1)[0]
    : null;
  return companyKey
    ? `/${encodeURIComponent(companyKey)}/issues/${encodeURIComponent(item.identifier)}`
    : `/issues/${encodeURIComponent(item.issueId)}`;
}

function dispositionLabel(
  disposition: StewardAttentionCase["recommendedDisposition"],
): string {
  if (disposition === "mark_done") return "Mark Done";
  if (disposition === "retry_requeue") return "Retry / requeue";
  if (disposition === "remain_blocked") return "Remain blocked";
  return "Human decision required";
}

function attentionItemId(item: StewardAttentionCase): string {
  return `${ATTENTION_ITEM_ID_PREFIX}${item.issueId}:${item.proposalFingerprint.slice(0, 40)}`;
}

function humanGateSummary(
  issue: Issue,
  interaction: IssueThreadInteraction,
): StewardExistingHumanGate {
  const payload = record(interaction.payload);
  const acceptLabel =
    typeof payload?.acceptLabel === "string" ? payload.acceptLabel : "Accept";
  const rejectLabel =
    typeof payload?.rejectLabel === "string" ? payload.rejectLabel : "Reject";
  const continuation = interaction.continuationPolicy ?? "none";
  const continuationEffect =
    continuation === "wake_assignee"
      ? "resolving it requests a wake for the current assignee"
      : continuation === "wake_assignee_on_accept"
        ? "accepting it requests a wake for the current assignee; rejecting it does not"
        : "resolving it does not wake an assignee or start a run";
  const identifier = issue.identifier ?? issue.id;
  return {
    identifier,
    issueId: issue.id,
    issueTitle: issue.title,
    status: issue.status,
    interactionId: interaction.id,
    interactionTitle: interaction.title ?? "Human decision",
    summary: interaction.summary ?? "A human-only decision is already pending.",
    prompt:
      typeof payload?.prompt === "string"
        ? payload.prompt
        : "Review the existing source interaction.",
    acceptEffect: `${acceptLabel}: records acceptance on the existing source interaction; ${continuationEffect}. It does not mark the issue Done.`,
    rejectEffect: `${rejectLabel}: records rejection on the existing source interaction; ${continuationEffect}. It does not cancel or complete the source issue.`,
    href: `${issueHref({ identifier, issueId: issue.id })}#interaction-${interaction.id}`,
    updatedAt: String(interaction.updatedAt),
  };
}

function attentionItemPreview(item: StewardAttentionCase): string {
  const evidence =
    item.latestEvidence.length > 0
      ? item.latestEvidence.map((entry) => `- ${entry}`).join("\n")
      : "- No recent comment is treated as conclusive evidence.";
  const conflict =
    item.conflictingEvidence.length > 0
      ? `\n\n**Conflicting evidence**\n${item.conflictingEvidence.map((entry) => `- ${entry}`).join("\n")}`
      : "";
  return [
    `**Current state:** ${item.status}`,
    `**Why it remains open:** ${item.reason}`,
    `**Recommended disposition:** ${dispositionLabel(item.recommendedDisposition)}`,
    `**Confidence:** ${item.confidence}`,
    `**Authority required:** ${item.authorityRequired}`,
    `**Exact effect if approved:** ${item.exactMutation}`,
    `**Why automatic action was refused:** ${item.automaticRefusalReason}`,
    "",
    "**Latest relevant evidence**",
    evidence,
    conflict,
    "",
    "**Verdict semantics**",
    `- **Approve:** authorises only the exact effect above. A separate audited apply pass revalidates ${item.identifier} immediately before any mutation.`,
    "- **Reject:** makes no source change and requires a reason so the proposal can be corrected.",
    "- **Defer:** makes no source change and leaves the current fence in place.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildStewardAttentionInteraction(
  attentionIssue: Issue,
  cases: StewardAttentionCase[],
  fingerprint: string,
  existingHumanGates: StewardExistingHumanGate[],
): CreateIssueThreadInteraction {
  const sorted = [...cases].sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
  const gateDetails = [...existingHumanGates]
    .sort((a, b) => a.identifier.localeCompare(b.identifier))
    .flatMap((gate) => [
      `- [${gate.identifier}: ${gate.interactionTitle}](${gate.href}) · **${gate.status}**`,
      `  - Why it remains open: ${gate.summary}`,
      `  - Decision: ${gate.prompt}`,
      `  - ${gate.acceptEffect}`,
      `  - ${gate.rejectEffect}`,
    ]);
  const details = [
    "Each item below is a governed proposal, not an acknowledgement. Approve authorises only the displayed mutation; Reject and Defer change no source issue. The periodic apply pass revalidates source state and fails closed before any mutation.",
    ...(existingHumanGates.length > 0
      ? [
          "",
          `**Existing human decisions (${existingHumanGates.length}, linked rather than duplicated)**`,
          ...gateDetails,
        ]
      : []),
  ].join("\n");
  return {
    kind: "request_item_verdicts",
    idempotencyKey: `${ATTENTION_IDEMPOTENCY_PREFIX}${fingerprint}`,
    title: `Recovery decisions: ${cases.length} governed proposal${cases.length === 1 ? "" : "s"}`,
    summary:
      "Review concise evidence and the exact proposed effect for each fenced issue. No verdict mutates a source issue directly.",
    resolverPolicy: "human_only",
    continuationPolicy: "none",
    ...(attentionIssue.responsibleUserId
      ? { addresseeUserId: attentionIssue.responsibleUserId }
      : {}),
    payload: {
      version: 1,
      prompt: `Decide ${cases.length} explicit recovery proposal${cases.length === 1 ? "" : "s"}. Approval authorises only the displayed effect; application is separate and revalidated.`,
      detailsMarkdown: details,
      items: sorted.map((item) => ({
        id: attentionItemId(item),
        label: `${item.identifier} · ${compactEvidenceText(
          item.title,
          Math.max(1, 117 - item.identifier.length),
        )}`,
        description: `${item.status} · ${dispositionLabel(item.recommendedDisposition)} · ${item.confidence} confidence`,
        previewMarkdown: attentionItemPreview(item),
        href: issueHref(item),
      })),
      verdicts: ["approve", "reject", "defer"],
      requireReasonOn: ["reject"],
      reasonLabel: "Reason / correction",
      allowBulkApprove: false,
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
  const pendingHumanInteractions = (interactions ?? []).filter(
    isPendingHumanInteraction,
  );

  if (activeRun && ["queued", "running"].includes(activeRun.status)) {
    return {
      issue,
      run: null,
      activeRun,
      pendingHumanInteractionIds,
      pendingHumanInteractions,
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
      pendingHumanInteractions,
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
      pendingHumanInteractions,
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
      pendingHumanInteractions,
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
      pendingHumanInteractions,
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
    pendingHumanInteractions,
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

async function latestIssueComments(
  ctx: ResolvedClientContext,
  issueId: string,
): Promise<IssueComment[]> {
  const params = new URLSearchParams({
    order: "desc",
    limit: String(COMMENT_EVIDENCE_LIMIT),
  });
  return (
    (await ctx.api.get<IssueComment[]>(
      `${apiPath`/api/issues/${issueId}/comments`}?${params.toString()}`,
    )) ?? []
  );
}

interface StewardAttentionState {
  openIssues: Issue[];
  inspections: StewardReconciliationInspection[];
  cases: StewardAttentionCase[];
  existingHumanGates: StewardExistingHumanGate[];
}

async function collectStewardAttentionState(
  ctx: ResolvedClientContext,
  companyId: string,
  attentionIssueId: string,
): Promise<StewardAttentionState> {
  const openIssues = await listOpenIssues(ctx, companyId);
  const inspections: StewardReconciliationInspection[] = [];
  const cases: StewardAttentionCase[] = [];
  const existingHumanGates: StewardExistingHumanGate[] = [];
  const inspectedIssueIds = new Set<string>();

  for (const issue of openIssues) {
    if (issue.id === attentionIssueId) continue;
    const inspection = await inspectHeldIssue(ctx, issue.id);
    if (!inspection) continue;
    inspections.push(inspection);
    inspectedIssueIds.add(inspection.issue.id);
    if (inspection.pendingHumanInteractions.length > 0) {
      existingHumanGates.push(
        ...inspection.pendingHumanInteractions.map((interaction) =>
          humanGateSummary(inspection.issue, interaction),
        ),
      );
    }
    if (inspection.classification === "human_gate") {
      continue;
    }
    const comments = isAttentionClassification(inspection.classification)
      ? await latestIssueComments(ctx, inspection.issue.id)
      : [];
    const item = deriveStewardAttentionCase(inspection, comments);
    if (item) cases.push(item);
  }

  for (const issue of openIssues) {
    if (issue.id === attentionIssueId || inspectedIssueIds.has(issue.id)) continue;
    const uncovered = await uncoveredBoardAttentionCase(ctx, issue);
    if (uncovered.pendingHumanInteractions.length > 0) {
      existingHumanGates.push(
        ...uncovered.pendingHumanInteractions.map((interaction) =>
          humanGateSummary(issue, interaction),
        ),
      );
    }
    if (!uncovered.inspection) continue;
    const comments = await latestIssueComments(ctx, uncovered.inspection.issue.id);
    const item = deriveStewardAttentionCase(uncovered.inspection, comments);
    if (item) cases.push(item);
  }

  cases.sort((a, b) => a.identifier.localeCompare(b.identifier));
  existingHumanGates.sort((a, b) =>
    a.identifier === b.identifier
      ? a.interactionId.localeCompare(b.interactionId)
      : a.identifier.localeCompare(b.identifier),
  );
  return { openIssues, inspections, cases, existingHumanGates };
}

async function inspectCurrentAttentionProposal(
  ctx: ResolvedClientContext,
  issueId: string,
): Promise<StewardAttentionCase | null> {
  const issue = requireResponse(
    await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`),
    `issue ${issueId}`,
  );
  let inspection: StewardReconciliationInspection | null;
  if (issue.executionBlocker) {
    inspection = await inspectHeldIssue(ctx, issue.id);
  } else {
    inspection = (await uncoveredBoardAttentionCase(ctx, issue)).inspection;
  }
  if (!inspection || !isAttentionClassification(inspection.classification)) {
    return null;
  }
  return deriveStewardAttentionCase(
    inspection,
    await latestIssueComments(ctx, issue.id),
  );
}

async function withdrawAttentionInteraction(
  ctx: ResolvedClientContext,
  attentionIssueId: string,
  interactionId: string,
  reason: string,
): Promise<void> {
  await ctx.api.post(
    apiPath`/api/issues/${attentionIssueId}/interactions/${interactionId}/withdraw`,
    { reason },
  );
}

function parseAttentionItemId(
  itemId: string,
): { issueId: string; proposalFingerprint: string } | null {
  if (!itemId.startsWith(ATTENTION_ITEM_ID_PREFIX)) return null;
  const value = itemId.slice(ATTENTION_ITEM_ID_PREFIX.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    issueId: value.slice(0, separator),
    proposalFingerprint: value.slice(separator + 1),
  };
}

function approvedAttentionDecisions(
  interactions: IssueThreadInteraction[],
): Array<{
  interaction: RequestItemVerdictsInteraction;
  itemId: string;
  issueId: string;
  proposalFingerprint: string;
}> {
  const decisions: Array<{
    interaction: RequestItemVerdictsInteraction;
    itemId: string;
    issueId: string;
    proposalFingerprint: string;
  }> = [];
  for (const interaction of interactions) {
    if (
      interaction.kind !== "request_item_verdicts" ||
      !interaction.idempotencyKey?.startsWith(ATTENTION_IDEMPOTENCY_PREFIX) ||
      !["pending", "answered"].includes(interaction.status)
    ) {
      continue;
    }
    for (const verdict of interaction.result?.items ?? []) {
      if (verdict.verdict !== "approve") continue;
      const parsed = parseAttentionItemId(verdict.id);
      if (!parsed) continue;
      decisions.push({
        interaction,
        itemId: verdict.id,
        issueId: parsed.issueId,
        proposalFingerprint: parsed.proposalFingerprint,
      });
    }
  }
  return decisions;
}

export async function applyStewardProposal(
  ctx: ResolvedClientContext,
  proposal: StewardAttentionCase,
): Promise<void> {
  if (
    proposal.recommendedDisposition === "remain_blocked" ||
    proposal.recommendedDisposition === "human_decision_required"
  ) {
    return;
  }
  if (!proposal.targetStatus) {
    throw new Error("Proposal is missing a target status.");
  }

  if (proposal.recoveryActionId && proposal.runId) {
    const actionOutcome =
      proposal.recommendedDisposition === "mark_done" ? "completed" : "mixed";
    const result = requireResponse(
      await ctx.api.post<ResolveIssueRecoveryActionResponse>(
        apiPath`/api/issues/${proposal.issueId}/recovery-actions/resolve`,
        {
          actionId: proposal.recoveryActionId,
          outcome: "restored",
          sourceIssueStatus: proposal.targetStatus,
          continuationPolicy: "manual",
          resolutionNote: `Governed Board Steward proposal approved on the operator review. ${proposal.exactMutation}`,
          executionReconciliation: {
            runId: proposal.runId,
            providerStopped: true,
            providerAdmission: "terminal_receipt",
            actionOutcome,
            outcomeEvidence: `Governed Board Steward proposal ${proposal.proposalFingerprint} was approved after presenting current state, relevant and conflicting evidence, authority, and the exact mutation. The apply pass revalidated the same source snapshot immediately before mutation.`,
          },
        },
      ),
      `recovery action ${proposal.recoveryActionId}`,
    );
    if (result.executionReconciliationResult?.continuationDelivery !== "not_required") {
      throw new Error(
        `Postcondition failed: continuationDelivery=${result.executionReconciliationResult?.continuationDelivery ?? "missing"}`,
      );
    }
  } else {
    await ctx.api.patch(apiPath`/api/issues/${proposal.issueId}`, {
      status: proposal.targetStatus,
      comment: `Governed Board Steward proposal approved and revalidated. ${proposal.exactMutation}`,
    });
  }

  const [verifiedIssue, verifiedActiveRun] = await Promise.all([
    ctx.api.get<Issue>(apiPath`/api/issues/${proposal.issueId}`),
    ctx.api.get<HeartbeatRun | null>(
      apiPath`/api/issues/${proposal.issueId}/active-run`,
    ),
  ]);
  const current = requireResponse(
    verifiedIssue,
    `post-apply issue ${proposal.issueId}`,
  );
  if (
    current.status !== proposal.targetStatus ||
    current.executionBlocker ||
    (verifiedActiveRun && ["queued", "running"].includes(verifiedActiveRun.status))
  ) {
    throw new Error(
      `Postcondition failed: status=${current.status}, executionBlocker=${Boolean(current.executionBlocker)}, activeRun=${verifiedActiveRun?.id ?? "none"}`,
    );
  }
}

export async function applyStewardAttentionReview(
  ctx: ResolvedClientContext,
  input: {
    companyId: string;
    attentionIssue: Issue;
    cases: StewardAttentionCase[];
    existingHumanGates: StewardExistingHumanGate[];
    interactions: IssueThreadInteraction[];
    apply: boolean;
    scannedIssueCount: number;
    heldIssueCount: number;
  },
): Promise<StewardAttentionReport> {
  const fingerprint = stewardAttentionFingerprint(
    input.cases,
    input.existingHumanGates,
  );
  const ownedInteractions = input.interactions.filter(
    (interaction) =>
      interaction.idempotencyKey?.startsWith(ATTENTION_IDEMPOTENCY_PREFIX) ||
      interaction.idempotencyKey?.startsWith(
        LEGACY_ATTENTION_IDEMPOTENCY_PREFIX,
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
    schema: "paperclip.steward_attention.v2",
    mode: input.apply ? "apply" : "dry_run",
    companyId: input.companyId,
    scannedAt: new Date().toISOString(),
    scannedIssueCount: input.scannedIssueCount,
    heldIssueCount: input.heldIssueCount,
    attentionCaseCount: input.cases.length,
    humanGateCount: input.existingHumanGates.length,
    fingerprint,
    interactionId: current?.id ?? null,
    action: "none",
    supersededInteractionIds: [],
    reason: "No operator proposal review is required.",
    cases: input.cases,
    existingHumanGates: input.existingHumanGates,
  };

  if (input.cases.length === 0) {
    if (stalePending.length === 0) {
      report.reason =
        "No judgement cases or stale pending proposal review exist.";
    } else if (!input.apply) {
      report.action = "would_clear";
      report.reason = `${stalePending.length} stale pending proposal review interaction(s) would be withdrawn.`;
    } else {
      for (const interaction of stalePending) {
        await withdrawAttentionInteraction(
          ctx,
          input.attentionIssue.id,
          interaction.id,
          "No fenced recovery case currently requires judgement.",
        );
        report.supersededInteractionIds.push(interaction.id);
      }
      report.action = "cleared";
      report.reason =
        "Stale proposal review withdrawn because no judgement cases remain.";
    }
  } else if (current) {
    if (input.apply) {
      for (const interaction of stalePending) {
        await withdrawAttentionInteraction(
          ctx,
          input.attentionIssue.id,
          interaction.id,
          "Superseded by the current deterministic governed proposal review.",
        );
        report.supersededInteractionIds.push(interaction.id);
      }
    }
    report.action =
      current.status === "pending"
        ? "pending_unchanged"
        : "decided_unchanged";
    report.reason =
      current.status === "pending"
        ? "The current governed proposal review is already pending; no duplicate was created."
        : "The current proposals were already decided; unchanged cases remain suppressed.";
  } else if (!input.apply) {
    report.action = "would_notify";
    report.reason =
      "A changed recovery-case set would create one human-only governed proposal review.";
  } else {
    try {
      const created = requireResponse(
        await ctx.api.post<IssueThreadInteraction>(
          apiPath`/api/issues/${input.attentionIssue.id}/interactions`,
          buildStewardAttentionInteraction(
            input.attentionIssue,
            input.cases,
            fingerprint!,
            input.existingHumanGates,
          ),
        ),
        "steward attention interaction",
      );
      report.interactionId = created.id;
      for (const interaction of stalePending) {
        await withdrawAttentionInteraction(
          ctx,
          input.attentionIssue.id,
          interaction.id,
          "Superseded by a changed deterministic governed proposal review.",
        );
        report.supersededInteractionIds.push(interaction.id);
      }
      report.action = "notified";
      report.reason =
        "Created one human-only governed proposal review; source issues and recovery gates were not changed.";
    } catch (error) {
      report.action = "failed";
      report.reason = error instanceof Error ? error.message : String(error);
    }
  }

  return report;
}

export async function runStewardApplyDecisions(
  ctx: ResolvedClientContext,
  input: {
    companyId: string;
    attentionIssueId: string;
    apply: boolean;
    maxActions: number;
  },
): Promise<StewardApplyDecisionsReport> {
  const attentionIssue = requireResponse(
    await ctx.api.get<Issue>(apiPath`/api/issues/${input.attentionIssueId}`),
    `attention issue ${input.attentionIssueId}`,
  );
  if (attentionIssue.companyId !== input.companyId) {
    throw new Error("The attention issue belongs to a different company.");
  }
  const interactions =
    (await ctx.api.get<IssueThreadInteraction[]>(
      apiPath`/api/issues/${attentionIssue.id}/interactions`,
    )) ?? [];
  const decisions = approvedAttentionDecisions(interactions);
  const actions: StewardApplyDecisionAction[] = [];
  let attemptedMutations = 0;

  for (const decision of decisions) {
    const current = await inspectCurrentAttentionProposal(
      ctx,
      decision.issueId,
    );
    if (!current) {
      actions.push({
        identifier: decision.issueId,
        issueId: decision.issueId,
        interactionId: decision.interaction.id,
        itemId: decision.itemId,
        recommendedDisposition: "human_decision_required",
        action: "skipped",
        reason:
          "The source is no longer an uncovered attention case. No mutation was attempted.",
        exactMutation: "None.",
      });
      continue;
    }
    const expectedItemId = attentionItemId(current);
    if (
      expectedItemId !== decision.itemId ||
      current.proposalFingerprint.slice(0, 40) !==
        decision.proposalFingerprint
    ) {
      actions.push({
        identifier: current.identifier,
        issueId: current.issueId,
        interactionId: decision.interaction.id,
        itemId: decision.itemId,
        recommendedDisposition: current.recommendedDisposition,
        action: "skipped",
        reason:
          "The source snapshot or recommended effect changed after the verdict. No mutation was attempted.",
        exactMutation: current.exactMutation,
      });
      continue;
    }

    if (
      current.recommendedDisposition === "remain_blocked" ||
      current.recommendedDisposition === "human_decision_required"
    ) {
      actions.push({
        identifier: current.identifier,
        issueId: current.issueId,
        interactionId: decision.interaction.id,
        itemId: decision.itemId,
        recommendedDisposition: current.recommendedDisposition,
        action: "recorded_no_source_change",
        reason:
          "The approved disposition intentionally preserves the current source fence; the interaction verdict is the audit record.",
        exactMutation: current.exactMutation,
      });
      continue;
    }

    if (attemptedMutations >= input.maxActions) {
      actions.push({
        identifier: current.identifier,
        issueId: current.issueId,
        interactionId: decision.interaction.id,
        itemId: decision.itemId,
        recommendedDisposition: current.recommendedDisposition,
        action: "skipped",
        reason: `The ${input.maxActions}-mutation budget was exhausted; this proposal remains pending application.`,
        exactMutation: current.exactMutation,
      });
      continue;
    }

    const action: StewardApplyDecisionAction = {
      identifier: current.identifier,
      issueId: current.issueId,
      interactionId: decision.interaction.id,
      itemId: decision.itemId,
      recommendedDisposition: current.recommendedDisposition,
      action: "would_apply",
      reason:
        "The approved proposal still matches the freshly derived source snapshot.",
      exactMutation: current.exactMutation,
    };
    actions.push(action);
    if (!input.apply) continue;

    attemptedMutations += 1;
    try {
      await applyStewardProposal(ctx, current);
      action.action = "applied";
      action.reason =
        "The exact approved proposal was applied after fresh revalidation; postconditions passed.";
    } catch (error) {
      action.action = "failed";
      action.reason = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    schema: "paperclip.steward_attention_apply.v1",
    mode: input.apply ? "apply" : "dry_run",
    companyId: input.companyId,
    scannedAt: new Date().toISOString(),
    approvedDecisionCount: decisions.length,
    mutationCandidateCount: actions.filter((action) =>
      ["would_apply", "applied", "failed"].includes(action.action),
    ).length,
    appliedCount: actions.filter((action) => action.action === "applied")
      .length,
    failedCount: actions.filter((action) => action.action === "failed")
      .length,
    actions,
  };
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
        "Create one de-duplicated governed proposal review for fenced recovery cases",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption(
        "--attention-issue <id>",
        "Stable open issue used to host the governed proposal review",
      )
      .option(
        "--apply",
        "Create or retire the proposal review; default is dry-run",
      )
      .action(async (opts: StewardAttentionOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = ctx.companyId!;
          const attentionIssue = await ctx.api.get<Issue>(
            apiPath`/api/issues/${opts.attentionIssue}`,
          );
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

          const { openIssues, inspections, cases, existingHumanGates } =
            await collectStewardAttentionState(
              ctx,
              companyId,
              presentAttentionIssue.id,
            );
          const interactions =
            (await ctx.api.get<IssueThreadInteraction[]>(
              apiPath`/api/issues/${presentAttentionIssue.id}/interactions`,
            )) ?? [];
          const report = await applyStewardAttentionReview(ctx, {
            companyId,
            attentionIssue: presentAttentionIssue,
            cases,
            existingHumanGates,
            interactions,
            apply: Boolean(opts.apply),
            scannedIssueCount: openIssues.length,
            heldIssueCount: inspections.length,
          });

          printOutput(report, { json: ctx.json });
          if (report.action === "failed") process.exitCode = 1;
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    steward
      .command("apply-decisions")
      .description(
        "Apply approved steward proposals only after revalidating each source issue",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption(
        "--attention-issue <id>",
        "Stable issue that hosts governed steward proposals",
      )
      .option("--apply", "Apply approved proposals; default is dry-run")
      .option("--max-actions <n>", "Maximum source mutations to apply", "5")
      .action(async (opts: StewardApplyDecisionsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = ctx.companyId!;
          const maxActions = parseMaxActions(opts.maxActions);
          const report = await runStewardApplyDecisions(ctx, {
            companyId,
            attentionIssueId: opts.attentionIssue,
            apply: Boolean(opts.apply),
            maxActions,
          });
          printOutput(report, { json: ctx.json });
          if (report.failedCount > 0) process.exitCode = 1;
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: false },
  );
}
