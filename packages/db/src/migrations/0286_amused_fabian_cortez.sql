-- Keep exactly one pending delivery owner for each reconciled source run. Prefer
-- an owner that already has a durable non-skipped wake receipt, then the oldest
-- recorded reconciliation. Losing rows retain their evidence but cannot deliver.
WITH ranked_pending AS (
  SELECT
    action.id,
    first_value(action.id) OVER owner_window AS canonical_id,
    row_number() OVER owner_window AS owner_rank
  FROM issue_recovery_actions action
  WHERE action.status = 'resolved'
    AND action.evidence->>'continuationDelivery' = 'pending'
    AND nullif(action.evidence->'executionReconciliation'->>'runId', '') IS NOT NULL
  WINDOW owner_window AS (
    PARTITION BY action.company_id, action.source_issue_id,
      action.evidence->'executionReconciliation'->>'runId'
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1
        FROM agent_wakeup_requests wake
        WHERE wake.company_id = action.company_id
          AND wake.status <> 'skipped'
          AND wake.payload->>'recoveryActionId' = action.id::text
      ) THEN 0 ELSE 1 END,
      action.created_at,
      action.id
  )
)
UPDATE issue_recovery_actions duplicate
SET outcome = 'cancelled',
    resolution_note = 'Duplicate pending continuation invalidated during source-run reconciliation migration.',
    next_action = 'Continuation delivery is owned by the canonical source-run reconciliation.',
    updated_at = now(),
    evidence = duplicate.evidence || jsonb_build_object(
      'continuationDelivery', 'invalidated',
      'duplicateOfRecoveryActionId', ranked_pending.canonical_id,
      'duplicateInvalidatedAt', now()
    )
FROM ranked_pending
WHERE duplicate.id = ranked_pending.id
  AND ranked_pending.owner_rank > 1;--> statement-breakpoint

-- An operator decision applies to the stopped source run, not just one recovery
-- row. Clear older same-run no-replay holds without giving them delivery rights.
WITH reconciliation_owners AS (
  SELECT DISTINCT ON (
    action.company_id,
    action.source_issue_id,
    action.evidence->'executionReconciliation'->>'runId'
  )
    action.company_id,
    action.source_issue_id,
    action.id,
    action.evidence->'executionReconciliation'->>'runId' AS run_id,
    action.evidence->'executionReconciliation' AS decision
  FROM issue_recovery_actions action
  WHERE action.status = 'resolved'
    AND action.evidence->>'continuationDelivery' IN ('pending', 'delivered')
    AND nullif(action.evidence->'executionReconciliation'->>'runId', '') IS NOT NULL
  ORDER BY
    action.company_id,
    action.source_issue_id,
    action.evidence->'executionReconciliation'->>'runId',
    CASE WHEN action.evidence->>'continuationDelivery' = 'delivered' THEN 0 ELSE 1 END,
    action.created_at,
    action.id
)
UPDATE issue_recovery_actions duplicate
SET outcome = 'cancelled',
    resolution_note = 'Duplicate no-replay hold invalidated by the source run reconciliation.',
    next_action = 'Continuation delivery is owned by the canonical source-run reconciliation.',
    updated_at = now(),
    evidence = (duplicate.evidence - 'automaticRecovery') || jsonb_build_object(
      'executionReconciliation', reconciliation_owners.decision,
      'continuationDelivery', 'invalidated',
      'duplicateOfRecoveryActionId', reconciliation_owners.id,
      'duplicateInvalidatedAt', now()
    )
FROM reconciliation_owners
WHERE duplicate.company_id = reconciliation_owners.company_id
  AND duplicate.source_issue_id = reconciliation_owners.source_issue_id
  AND duplicate.id <> reconciliation_owners.id
  AND duplicate.evidence->>'runId' = reconciliation_owners.run_id
  AND duplicate.evidence->'automaticRecovery'->>'replay' = 'blocked';--> statement-breakpoint

-- Historical databases can contain several unresolved holds for one failed run.
-- Preserve the oldest as the canonical operator decision point and neutralize
-- only its duplicates before installing the uniqueness invariant.
WITH ranked_holds AS (
  SELECT
    action.id,
    first_value(action.id) OVER hold_window AS canonical_id,
    row_number() OVER hold_window AS hold_rank
  FROM issue_recovery_actions action
  WHERE action.evidence->'automaticRecovery'->>'replay' = 'blocked'
    AND nullif(action.evidence->>'runId', '') IS NOT NULL
  WINDOW hold_window AS (
    PARTITION BY action.company_id, action.source_issue_id, action.evidence->>'runId'
    ORDER BY action.created_at, action.id
  )
)
UPDATE issue_recovery_actions duplicate
SET outcome = 'cancelled',
    resolution_note = 'Duplicate no-replay hold folded into the canonical source-run recovery record.',
    next_action = 'Inspect and reconcile the canonical recovery record for this stopped execution.',
    updated_at = now(),
    evidence = (duplicate.evidence - 'automaticRecovery') || jsonb_build_object(
      'duplicateOfRecoveryActionId', ranked_holds.canonical_id,
      'duplicateInvalidatedAt', now()
    )
FROM ranked_holds
WHERE duplicate.id = ranked_holds.id
  AND ranked_holds.hold_rank > 1;--> statement-breakpoint

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally. This new v2 namespace has no pre-migration rows and requires atomic at-most-once continuation admission.
CREATE UNIQUE INDEX "agent_wakeup_requests_execution_reconciliation_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'execution-reconciliation:v2:%' AND "agent_wakeup_requests"."status" <> 'skipped';--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally. The bounded duplicate repair above must commit atomically with the source-run hold invariant.
CREATE UNIQUE INDEX "issue_recovery_actions_effective_execution_hold_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id",("evidence"->>'runId')) WHERE "issue_recovery_actions"."evidence"->'automaticRecovery'->>'replay' = 'blocked';
