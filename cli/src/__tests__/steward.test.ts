import { describe, expect, it } from "vitest";
import type { HeartbeatRun, Issue } from "@paperclipai/shared";
import {
  buildStewardAttentionInteraction,
  classifyDeterministicNonAdmission,
  stewardAttentionFingerprint,
  type StewardAttentionCase,
} from "../commands/client/steward.js";

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
    ...overrides,
  };
}

describe("deterministic steward attention digest", () => {
  it("uses a stable order-independent fingerprint and changes it with source state", () => {
    const first = attentionCase("AND-732");
    const second = attentionCase("AND-624");
    expect(stewardAttentionFingerprint([first, second])).toBe(
      stewardAttentionFingerprint([second, first]),
    );
    expect(
      stewardAttentionFingerprint([
        first,
        { ...second, updatedAt: "2026-10-09T07:01:00.000Z" },
      ]),
    ).not.toBe(stewardAttentionFingerprint([first, second]));
    expect(stewardAttentionFingerprint([])).toBeNull();
  });

  it("builds one human-only acknowledgement without mutating source cases", () => {
    const cases = [
      attentionCase("AND-732"),
      attentionCase("AND-707", {
        classification: "unsettled_requires_judgement",
      }),
    ];
    const interaction = buildStewardAttentionInteraction(
      {
        id: "attention-issue",
        responsibleUserId: "andy-user",
      } as Issue,
      cases,
      "abc123",
      4,
    );
    expect(interaction.resolverPolicy).toBe("human_only");
    expect(interaction.continuationPolicy).toBe("none");
    expect(interaction.addresseeUserId).toBe("andy-user");
    expect(interaction.idempotencyKey).toBe(
      "factory-recovery-attention:v1:abc123",
    );
    expect(interaction.kind).toBe("request_confirmation");
    if (interaction.kind !== "request_confirmation") {
      throw new Error("Expected request_confirmation interaction");
    }
    expect(interaction.payload.detailsMarkdown).toContain(
      "[AND-732](/AND/issues/AND-732)",
    );
    expect(interaction.payload.detailsMarkdown).toContain(
      "4 additional issues have an existing pending human-only interaction",
    );
  });
});
