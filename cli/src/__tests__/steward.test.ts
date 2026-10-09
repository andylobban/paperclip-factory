import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { classifyDeterministicNonAdmission } from "../commands/client/steward.js";

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
