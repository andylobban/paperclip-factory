import { describe, expect, it, vi } from "vitest";
import type { HeartbeatRun, Issue, IssueComment } from "@paperclipai/shared";
import {
  applyStewardAttentionReview,
  applyStewardProposal,
  buildStewardAttentionInteraction,
  classifyDeterministicNonAdmission,
  deriveStewardAttentionCase,
  runStewardApplyDecisions,
  stewardAttentionFingerprint,
  type StewardAttentionCase,
  type StewardExistingHumanGate,
  type StewardReconciliationInspection,
} from "../commands/client/steward.js";
import type { ResolvedClientContext } from "../commands/client/common.js";

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    error: null,
    errorCode: null,
    startedAt: null,
    lastUsefulActionAt: null,
    usageJson: null,
    resultJson: null,
    ...overrides,
  } as HeartbeatRun;
}

describe("deterministic steward reconciliation", () => {
  it("recognises the stale queued-review gate", () => {
    expect(
      classifyDeterministicNonAdmission(
        run({
          status: "cancelled",
          errorCode: "issue_continuation_waiting_on_review",
          resultJson: {
            stopReason: "issue_continuation_waiting_on_review",
            timeoutSource: "stale_queued_run_gate",
          },
        }),
      ),
    ).toBe("stale_queued_review_gate");
  });

  it("recognises a gateway refusal before provider admission", () => {
    expect(
      classifyDeterministicNonAdmission(
        run({
          status: "failed",
          startedAt: new Date("2026-10-06T00:10:21.499Z"),
          errorCode: "openclaw_gateway_request_failed",
          error: "connect ECONNREFUSED 127.0.0.1:18789",
          resultJson: { stopReason: "adapter_failed" },
        }),
      ),
    ).toBe("gateway_connection_refused");
  });

  it("refuses to infer non-admission from a generic timeout", () => {
    expect(
      classifyDeterministicNonAdmission(
        run({
          status: "timed_out",
          resultJson: { stopReason: "timeout", timeoutFired: true },
        }),
      ),
    ).toBeNull();
  });

  it("keeps any run with usage or a provider settlement fenced", () => {
    expect(
      classifyDeterministicNonAdmission(
        run({
          errorCode: "openclaw_gateway_request_failed",
          error: "connect ECONNREFUSED 127.0.0.1:18789",
          resultJson: { stopReason: "adapter_failed" },
          usageJson: { inputTokens: 1 },
        }),
      ),
    ).toBeNull();
    expect(
      classifyDeterministicNonAdmission(
        run({
          errorCode: "openclaw_gateway_request_failed",
          error: "connect ECONNREFUSED 127.0.0.1:18789",
          resultJson: {
            stopReason: "adapter_failed",
            providerSettlement: { state: "terminal" },
          },
        }),
      ),
    ).toBeNull();
  });
});

function attentionCase(
  identifier: string,
  overrides: Partial<StewardAttentionCase> = {},
): StewardAttentionCase {
  return {
    identifier,
    issueId: `issue-${identifier}`,
    title: `Title ${identifier}`,
    status: "blocked",
    classification: "terminal_receipt_requires_judgement",
    reason: "Outcome needs judgement.",
    runId: `run-${identifier}`,
    recoveryActionId: `recovery-${identifier}`,
    updatedAt: "2026-10-09T07:00:00.000Z",
    latestEvidence: ["Current structured evidence."],
    conflictingEvidence: [],
    recommendedDisposition: "retry_requeue",
    confidence: "medium",
    authorityRequired: "Board operator.",
    exactMutation: `Set ${identifier} to todo; no successor run.`,
    automaticRefusalReason: "A governed state change requires approval.",
    targetStatus: "todo",
    proposalFingerprint: `proposal-${identifier}`,
    ...overrides,
  };
}

function issue(
  identifier: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id: `00000000-0000-4000-8000-${identifier.slice(4).padStart(12, "0")}`,
    identifier,
    title: `Title ${identifier}`,
    status: "blocked",
    updatedAt: "2026-10-09T07:00:00.000Z",
    blockedBy: [],
    executionBlocker: {
      recoveryActionId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      cause: "legacy_execution_requires_reconciliation",
      nextAction: "Inspect the stopped run.",
    },
    ...overrides,
  } as Issue;
}

function inspection(
  identifier: string,
  overrides: Partial<StewardReconciliationInspection> = {},
): StewardReconciliationInspection {
  return {
    issue: issue(identifier),
    run: run({
      id: "22222222-2222-4222-8222-222222222222",
      status: "failed",
      resultJson: {
        providerSettlement: {
          state: "terminal",
          runId: "22222222-2222-4222-8222-222222222222",
          terminalStatus: "ok",
          settledAt: "2026-10-09T06:59:00.000Z",
        },
      },
    }),
    activeRun: null,
    pendingHumanInteractionIds: [],
    pendingHumanInteractions: [],
    classification: "terminal_receipt_requires_judgement",
    reason: "Terminal receipt requires task-outcome judgement.",
    ...overrides,
  };
}

function comment(body: string, createdAt: string): IssueComment {
  return {
    id: `${createdAt}-${body.slice(0, 4)}`,
    companyId: "company",
    issueId: "issue",
    authorType: "agent",
    authorAgentId: "agent",
    authorUserId: null,
    body,
    presentation: null,
    metadata: null,
    createdAt,
    updatedAt: createdAt,
  } as unknown as IssueComment;
}

describe("deterministic steward governed proposals", () => {
  it("uses a stable order-independent fingerprint and changes it with source state", () => {
    const first = attentionCase("AND-732");
    const second = attentionCase("AND-624");
    expect(stewardAttentionFingerprint([first, second])).toBe(
      stewardAttentionFingerprint([second, first]),
    );
    expect(
      stewardAttentionFingerprint([
        first,
        { ...second, proposalFingerprint: "changed-proposal" },
      ]),
    ).not.toBe(stewardAttentionFingerprint([first, second]));
    expect(stewardAttentionFingerprint([])).toBeNull();
  });

  it("builds one human-only item review with explicit action semantics", () => {
    const cases = [
      attentionCase("AND-732"),
      attentionCase("AND-707", {
        classification: "unsettled_requires_judgement",
      }),
    ];
    const gate: StewardExistingHumanGate = {
      identifier: "AND-469",
      issueId: "issue-469",
      issueTitle: "SSH hardening",
      status: "blocked",
      interactionId: "interaction-469",
      interactionTitle: "Approve bounded SSH change",
      summary: "A privileged change needs approval.",
      prompt: "Approve the bounded change?",
      acceptEffect: "Approve: records the source decision; it does not mark Done.",
      rejectEffect: "Reject: leaves source work blocked.",
      href: "/AND/issues/AND-469#interaction-interaction-469",
      updatedAt: "2026-10-09T07:00:00.000Z",
    };
    const interaction = buildStewardAttentionInteraction(
      {
        id: "attention-issue",
        responsibleUserId: "andy-user",
      } as Issue,
      cases,
      "abc123",
      [gate],
    );
    expect(interaction.resolverPolicy).toBe("human_only");
    expect(interaction.continuationPolicy).toBe("none");
    expect(interaction.addresseeUserId).toBe("andy-user");
    expect(interaction.idempotencyKey).toBe(
      "factory-recovery-attention:v2:abc123",
    );
    expect(interaction.kind).toBe("request_item_verdicts");
    if (interaction.kind !== "request_item_verdicts") {
      throw new Error("Expected request_item_verdicts interaction");
    }
    expect(interaction.payload.detailsMarkdown).toContain(
      "AND-469: Approve bounded SSH change",
    );
    expect(interaction.payload.items).toHaveLength(2);
    expect(interaction.payload.allowBulkApprove).toBe(false);
    expect(interaction.payload.items[0]?.previewMarkdown).toContain(
      "Exact effect if approved",
    );
    expect(interaction.payload.items[0]?.previewMarkdown).toContain(
      "Reject:** makes no source change",
    );
  });

  it.each([
    {
      identifier: "AND-624",
      expected: "retry_requeue",
      issue: issue("AND-624"),
      comments: [comment("The restart approval was accepted; work still remains blocked.", "2026-10-09T06:00:00.000Z")],
    },
    {
      identifier: "AND-663",
      expected: "retry_requeue",
      issue: issue("AND-663", {
        executionState: {
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
        } as unknown as Issue["executionState"],
      }),
      comments: [
        comment("A comment claims this is fixed.", "2026-10-09T06:00:00.000Z"),
        comment("Independent review changes requested after a fresh failure.", "2026-10-09T06:01:00.000Z"),
      ],
    },
    {
      identifier: "AND-707",
      expected: "remain_blocked",
      issue: issue("AND-707"),
      classification: "unsettled_requires_judgement" as const,
      comments: [comment("Implementation progressed but is not complete.", "2026-10-09T06:00:00.000Z")],
    },
    {
      identifier: "AND-732",
      expected: "retry_requeue",
      issue: issue("AND-732", { reviewPolicy: null }),
      comments: [comment("Local work is complete but live verification remains.", "2026-10-09T06:00:00.000Z")],
    },
    {
      identifier: "AND-806",
      expected: "retry_requeue",
      issue: issue("AND-806", { executionBlocker: null }),
      classification: "blocked_state_requires_attention" as const,
      comments: [comment("Parent-owner handoff is required.", "2026-10-09T06:00:00.000Z")],
    },
    {
      identifier: "AND-966",
      expected: "remain_blocked",
      issue: issue("AND-966", {
        executionBlocker: null,
        blockedBy: [
          {
            id: "blocker-972",
            identifier: "AND-972",
            title: "Independent QA",
            status: "blocked",
          },
        ] as unknown as Issue["blockedBy"],
      }),
      classification: "blocked_state_requires_attention" as const,
      comments: [comment("Independent QA is still blocked.", "2026-10-09T06:00:00.000Z")],
    },
  ])("derives a fail-closed proposal for $identifier", (fixture) => {
    const result = deriveStewardAttentionCase(
      inspection(fixture.identifier, {
        issue: fixture.issue,
        classification:
          fixture.classification ?? "terminal_receipt_requires_judgement",
      }),
      fixture.comments,
    );
    expect(result?.recommendedDisposition).toBe(fixture.expected);
    expect(result?.exactMutation).toBeTruthy();
    expect(result?.automaticRefusalReason).toBeTruthy();
    if (fixture.identifier === "AND-663") {
      expect(result?.recommendedDisposition).not.toBe("mark_done");
      expect(result?.conflictingEvidence.length).toBeGreaterThan(0);
    }
    if (fixture.identifier === "AND-966") {
      expect(result?.exactMutation).toContain("No source issue");
    }
  });

  it.each(["AND-678", "AND-469"])(
    "does not create a duplicate proposal for %s when a human gate is authoritative",
    (identifier) => {
      expect(
        deriveStewardAttentionCase(
          inspection(identifier, {
            classification: "human_gate",
            pendingHumanInteractionIds: ["human-gate"],
          }),
        ),
      ).toBeNull();
    },
  );
});

function fakeContext(api: {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
}): ResolvedClientContext {
  return {
    api,
    companyId: "company",
    profileName: "test",
    profile: { apiBase: "http://paperclip.test" },
    json: true,
    authSource: "explicit",
  } as unknown as ResolvedClientContext;
}

function approvedInteraction(
  proposals: StewardAttentionCase[],
): import("@paperclipai/shared").IssueThreadInteraction {
  return {
    id: "interaction-review",
    issueId: "attention-issue",
    kind: "request_item_verdicts",
    status: "answered",
    idempotencyKey: "factory-recovery-attention:v2:review",
    result: {
      items: proposals.map((proposal) => ({
        id: `steward:${proposal.issueId}:${proposal.proposalFingerprint.slice(0, 40)}`,
        verdict: "approve",
      })),
    },
  } as unknown as import("@paperclipai/shared").IssueThreadInteraction;
}

function completedProposalSource(identifier: string): {
  issue: Issue;
  run: HeartbeatRun;
  proposal: StewardAttentionCase;
} {
  const sourceIssue = issue(identifier, {
    executionState: {
      status: "completed",
      lastDecisionOutcome: "approved",
    } as unknown as Issue["executionState"],
  });
  const sourceRun = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "succeeded",
    resultJson: {
      providerSettlement: {
        state: "terminal",
        runId: "22222222-2222-4222-8222-222222222222",
        terminalStatus: "ok",
        settledAt: "2026-10-09T06:59:00.000Z",
      },
    },
  });
  const proposal = deriveStewardAttentionCase(
    inspection(identifier, { issue: sourceIssue, run: sourceRun }),
  );
  if (!proposal) throw new Error("Expected a governed proposal");
  return { issue: sourceIssue, run: sourceRun, proposal };
}

describe("governed steward mutation path", () => {
  it("creates the attention review without writing any source issue", async () => {
    const proposal = attentionCase("AND-732");
    const post = vi.fn(async (path: string) => ({
      id: "new-interaction",
      issueId: "attention-issue",
      kind: "request_item_verdicts",
      status: "pending",
      idempotencyKey: "factory-recovery-attention:v2:new",
    }));
    const patch = vi.fn();
    const ctx = fakeContext({ get: vi.fn(), post, patch });

    const report = await applyStewardAttentionReview(ctx, {
      companyId: "company",
      attentionIssue: {
        id: "attention-issue",
        companyId: "company",
        responsibleUserId: "andy-user",
      } as Issue,
      cases: [proposal],
      existingHumanGates: [],
      interactions: [],
      apply: true,
      scannedIssueCount: 1,
      heldIssueCount: 1,
    });

    expect(report.action).toBe("notified");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(
      "/api/issues/attention-issue/interactions",
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("revalidates a matching approval and applies only the displayed recovery mutation", async () => {
    const source = completedProposalSource("AND-663");
    let currentIssue = source.issue;
    const post = vi.fn(async (path: string, body: unknown) => {
      expect(path).toBe(
        `/api/issues/${source.issue.id}/recovery-actions/resolve`,
      );
      expect(body).toMatchObject({
        actionId: source.proposal.recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
        continuationPolicy: "manual",
        executionReconciliation: {
          runId: source.run.id,
          providerStopped: true,
          providerAdmission: "terminal_receipt",
          actionOutcome: "completed",
        },
      });
      currentIssue = {
        ...currentIssue,
        status: "done",
        executionBlocker: null,
      };
      return {
        executionReconciliationResult: {
          continuationDelivery: "not_required",
        },
      };
    });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/issues/attention-issue") {
        return { id: "attention-issue", companyId: "company" } as Issue;
      }
      if (path === "/api/issues/attention-issue/interactions") {
        return [approvedInteraction([source.proposal])];
      }
      if (path === `/api/issues/${source.issue.id}`) return currentIssue;
      if (path === `/api/issues/${source.issue.id}/active-run`) return null;
      if (path === `/api/issues/${source.issue.id}/interactions`) return [];
      if (path === `/api/heartbeat-runs/${source.run.id}`) return source.run;
      if (path.startsWith(`/api/issues/${source.issue.id}/comments?`)) return [];
      throw new Error(`Unexpected GET ${path}`);
    });
    const ctx = fakeContext({ get, post, patch: vi.fn() });

    const report = await runStewardApplyDecisions(ctx, {
      companyId: "company",
      attentionIssueId: "attention-issue",
      apply: true,
      maxActions: 5,
    });

    expect(report.appliedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    "fingerprint_changed",
    "active_run",
    "human_gate",
    "conflicting_review",
  ])("refuses %s without a source mutation", async (reason) => {
    const source = completedProposalSource("AND-663");
    let currentIssue = source.issue;
    let activeRun: HeartbeatRun | null = null;
    let interactions: import("@paperclipai/shared").IssueThreadInteraction[] = [];
    let comments: IssueComment[] = [];
    if (reason === "fingerprint_changed") {
      currentIssue = {
        ...currentIssue,
        updatedAt: new Date("2026-10-09T08:00:00.000Z"),
      };
    } else if (reason === "active_run") {
      activeRun = run({ id: "active-run", status: "running" });
    } else if (reason === "human_gate") {
      interactions = [
        {
          id: "human-gate",
          status: "pending",
          effectiveResolverPolicy: "human_only",
        } as unknown as import("@paperclipai/shared").IssueThreadInteraction,
      ];
    } else {
      currentIssue = {
        ...currentIssue,
        executionState: {
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
        } as unknown as Issue["executionState"],
      };
      comments = [
        comment("Fixed and complete.", "2026-10-09T08:00:00.000Z"),
        comment("Independent review changes requested.", "2026-10-09T08:01:00.000Z"),
      ];
    }
    const post = vi.fn();
    const patch = vi.fn();
    const get = vi.fn(async (path: string) => {
      if (path === "/api/issues/attention-issue") {
        return { id: "attention-issue", companyId: "company" } as Issue;
      }
      if (path === "/api/issues/attention-issue/interactions") {
        return [approvedInteraction([source.proposal])];
      }
      if (path === `/api/issues/${source.issue.id}`) return currentIssue;
      if (path === `/api/issues/${source.issue.id}/active-run`) return activeRun;
      if (path === `/api/issues/${source.issue.id}/interactions`) {
        return interactions;
      }
      if (path === `/api/heartbeat-runs/${source.run.id}`) return source.run;
      if (path.startsWith(`/api/issues/${source.issue.id}/comments?`)) {
        return comments;
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const ctx = fakeContext({ get, post, patch });

    const report = await runStewardApplyDecisions(ctx, {
      companyId: "company",
      attentionIssueId: "attention-issue",
      apply: true,
      maxActions: 5,
    });

    expect(report.appliedCount).toBe(0);
    expect(report.actions[0]?.action).toBe("skipped");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("fails closed when recovery continuation or postconditions are not exact", async () => {
    const source = completedProposalSource("AND-663");
    const post = vi.fn(async () => ({
      executionReconciliationResult: {
        continuationDelivery: "pending",
      },
    }));
    const ctx = fakeContext({ get: vi.fn(), post, patch: vi.fn() });

    await expect(applyStewardProposal(ctx, source.proposal)).rejects.toThrow(
      "continuationDelivery=pending",
    );
  });

  it.each([
    "wrong_target_status",
    "retained_execution_blocker",
    "new_active_run",
  ])("reports %s as a failed mutation", async (failure) => {
    const source = completedProposalSource("AND-663");
    let currentIssue = source.issue;
    let activeRunReads = 0;
    const post = vi.fn(async () => {
      currentIssue = {
        ...currentIssue,
        status: failure === "wrong_target_status" ? "todo" : "done",
        executionBlocker:
          failure === "retained_execution_blocker"
            ? currentIssue.executionBlocker
            : null,
      };
      return {
        executionReconciliationResult: {
          continuationDelivery: "not_required",
        },
      };
    });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/issues/attention-issue") {
        return { id: "attention-issue", companyId: "company" } as Issue;
      }
      if (path === "/api/issues/attention-issue/interactions") {
        return [approvedInteraction([source.proposal])];
      }
      if (path === `/api/issues/${source.issue.id}`) return currentIssue;
      if (path === `/api/issues/${source.issue.id}/active-run`) {
        activeRunReads += 1;
        return failure === "new_active_run" && activeRunReads > 1
          ? run({ id: "unexpected-run", status: "queued" })
          : null;
      }
      if (path === `/api/issues/${source.issue.id}/interactions`) return [];
      if (path === `/api/heartbeat-runs/${source.run.id}`) return source.run;
      if (path.startsWith(`/api/issues/${source.issue.id}/comments?`)) return [];
      throw new Error(`Unexpected GET ${path}`);
    });
    const ctx = fakeContext({ get, post, patch: vi.fn() });

    const report = await runStewardApplyDecisions(ctx, {
      companyId: "company",
      attentionIssueId: "attention-issue",
      apply: true,
      maxActions: 5,
    });

    expect(report.appliedCount).toBe(0);
    expect(report.failedCount).toBe(1);
    expect(report.actions[0]?.action).toBe("failed");
    expect(report.actions[0]?.reason).toContain("Postcondition failed");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("enforces a hard five-mutation budget", async () => {
    const sources = Array.from({ length: 6 }, (_, index) => {
      const identifier = `AND-${900 + index}`;
      const sourceIssue = issue(identifier, {
        status: "blocked",
        executionBlocker: null,
        blockerAttention: {
          state: "needs_attention",
        } as Issue["blockerAttention"],
      });
      const proposal = deriveStewardAttentionCase(
        inspection(identifier, {
          issue: sourceIssue,
          run: null,
          classification: "blocked_state_requires_attention",
        }),
      );
      if (!proposal) throw new Error("Expected bounded proposal");
      return { issue: sourceIssue, proposal };
    });
    const currentIssues = new Map(
      sources.map((source) => [source.issue.id, source.issue]),
    );
    const patch = vi.fn(async (path: string) => {
      const issueId = path.split("/")[3]!;
      const current = currentIssues.get(issueId)!;
      currentIssues.set(issueId, { ...current, status: "todo" });
      return currentIssues.get(issueId);
    });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/issues/attention-issue") {
        return { id: "attention-issue", companyId: "company" } as Issue;
      }
      if (path === "/api/issues/attention-issue/interactions") {
        return [approvedInteraction(sources.map((source) => source.proposal))];
      }
      const source = sources.find(({ issue: item }) =>
        path.startsWith(`/api/issues/${item.id}`),
      );
      if (!source) throw new Error(`Unexpected GET ${path}`);
      if (path === `/api/issues/${source.issue.id}`) {
        return currentIssues.get(source.issue.id);
      }
      if (path === `/api/issues/${source.issue.id}/active-run`) return null;
      if (path === `/api/issues/${source.issue.id}/interactions`) return [];
      if (path.startsWith(`/api/issues/${source.issue.id}/comments?`)) return [];
      throw new Error(`Unexpected GET ${path}`);
    });
    const ctx = fakeContext({ get, post: vi.fn(), patch });

    const report = await runStewardApplyDecisions(ctx, {
      companyId: "company",
      attentionIssueId: "attention-issue",
      apply: true,
      maxActions: 5,
    });

    expect(report.appliedCount).toBe(5);
    expect(report.actions[5]?.action).toBe("skipped");
    expect(report.actions[5]?.reason).toContain("5-mutation budget");
    expect(patch).toHaveBeenCalledTimes(5);
  });
});
