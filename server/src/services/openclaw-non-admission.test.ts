import { describe, expect, it } from "vitest";
import { isOpenClawPreAdmissionFailure } from "./openclaw-non-admission.js";

const unpublished = {
  errorCode: "openclaw_gateway_request_failed",
  error: "prepared reply dispatch runtime owner was not published for scully",
  resultJson: { stopReason: "adapter_failed" },
};
const unopened = {
  errorCode: "timeout",
  error: "gateway websocket open timeout",
  resultJson: { stopReason: "timeout" },
};

describe("OpenClaw pre-admission evidence", () => {
  it("recognises the configured agent's synchronous preaccept rejection", () => {
    expect(isOpenClawPreAdmissionFailure(unpublished, "scully")).toBe(true);
  });
  it.each(["timeout", "openclaw_gateway_timeout"])("recognises unopened transport with %s", (errorCode) => {
    expect(isOpenClawPreAdmissionFailure({ ...unopened, errorCode }, "scully")).toBe(true);
  });
  it.each([undefined, null, "", "turing", "scully extra", "scully\n"])("rejects an absent/mismatched agent %s", (agentId) => {
    expect(isOpenClawPreAdmissionFailure(unpublished, agentId)).toBe(false);
  });
  it.each([
    "gateway agent request timeout", "gateway agent.wait timeout", "gateway connect challenge timeout",
    "gateway websocket open timeout after dispatch", "prefix gateway websocket open timeout",
    "prepared reply dispatch runtime owner was not published for turing",
  ])("rejects ambiguous or nonmatching error %s", (error) => {
    expect(isOpenClawPreAdmissionFailure({ ...unopened, error }, "scully")).toBe(false);
  });
  it.each([
    { runId: "possibly-admitted" }, { status: "accepted" },
    { providerSettlement: { state: "terminal" } },
  ])("preserves evidence of provider admission %j", (evidence) => {
    for (const run of [unopened, unpublished]) {
      expect(isOpenClawPreAdmissionFailure({ ...run, resultJson: { ...run.resultJson, ...evidence } }, "scully")).toBe(false);
    }
  });
  it("requires the adapter-owned error family and stop reason", () => {
    expect(isOpenClawPreAdmissionFailure({ ...unpublished, errorCode: "timeout" }, "scully")).toBe(false);
    expect(isOpenClawPreAdmissionFailure({ ...unpublished, resultJson: null }, "scully")).toBe(false);
    expect(isOpenClawPreAdmissionFailure({ ...unopened, errorCode: "agent_timeout" }, "scully")).toBe(false);
  });
});
