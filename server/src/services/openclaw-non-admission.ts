/** Only exact errors whose adapter/gateway boundary precedes provider acceptance. */
export function isOpenClawPreAdmissionFailure(
  run: {
    errorCode: string | null;
    error: string | null;
    resultJson: Record<string, unknown> | null;
  },
  configuredAgentId: unknown,
): boolean {
  const result = run.resultJson;
  // A result from agent/agent.wait must never be reclassified as non-admission.
  if (result?.runId || result?.status || result?.providerSettlement) return false;

  if (
    run.errorCode === "openclaw_gateway_request_failed" &&
    result?.stopReason === "adapter_failed" &&
    typeof configuredAgentId === "string" &&
    /^[a-z0-9][a-z0-9_-]*$/.test(configuredAgentId) &&
    run.error === `prepared reply dispatch runtime owner was not published for ${configuredAgentId}`
  ) {
    // OpenClaw rejects this in rejectPreaccept before emitting acceptance.
    return true;
  }

  // GatewayClient.connect times out here before connect or agent can be sent.
  // reportDispatch prevents reconnect/retry after any earlier agent request.
  return (
    ["timeout", "openclaw_gateway_timeout"].includes(run.errorCode ?? "") &&
    ["timeout", "adapter_failed"].includes(String(result?.stopReason ?? "")) &&
    run.error === "gateway websocket open timeout"
  );
}
