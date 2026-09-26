export function executionReconciliationIdempotencyKey(
  companyId: string,
  sourceRunId: string,
) {
  return `execution-reconciliation:v2:${companyId}:${sourceRunId}`;
}

export function legacyExecutionReconciliationIdempotencyKey(
  recoveryActionId: string,
) {
  return `execution-reconciliation:${recoveryActionId}`;
}
