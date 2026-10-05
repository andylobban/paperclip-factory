-- OpenClaw adapter versions before provider-settlement fencing stored the exact
-- terminal agent.wait receipt at the top level of result_json. Promote only
-- receipts that identify this exact heartbeat run, have a provider-terminal
-- status, carry a finite millisecond endedAt, and agree with Paperclip's final
-- run status. Ambiguous timeouts and accepted-only envelopes remain fenced.
-- paperclip:migration-safety-ignore full-table-mutation-large-table: The predicate is restricted to OpenClaw terminal runs with an absent nested receipt and an exact legacy run ID; this one-time repair makes already-recorded terminal evidence usable without replay.
UPDATE heartbeat_runs AS run
SET result_json = run.result_json || jsonb_build_object(
  'providerSettlement',
  jsonb_build_object(
    'state', 'terminal',
    'runId', run.id::text,
    'terminalStatus', run.result_json->>'status',
    'settledAt', to_char(
      to_timestamp((run.result_json->>'endedAt')::double precision / 1000.0)
        AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'source', 'agent.wait',
    'receipt', jsonb_strip_nulls(jsonb_build_object(
      'runId', run.result_json->>'runId',
      'status', run.result_json->>'status',
      'startedAt', run.result_json->'startedAt',
      'endedAt', run.result_json->'endedAt',
      'error', run.result_json->>'error'
    )),
    'normalisedFrom', 'legacy_top_level_agent_wait'
  )
)
FROM agents AS agent
WHERE agent.id = run.agent_id
  AND agent.company_id = run.company_id
  AND agent.adapter_type = 'openclaw_gateway'
  AND run.result_json IS NOT NULL
  AND NOT (run.result_json ? 'providerSettlement')
  AND run.result_json->>'runId' = run.id::text
  AND jsonb_typeof(run.result_json->'endedAt') = 'number'
  AND (run.result_json->>'endedAt')::double precision > 0
  AND (run.result_json->>'endedAt')::double precision < 8640000000000000
  AND (
    (run.result_json->>'status' = 'ok' AND run.status = 'succeeded')
    OR (run.result_json->>'status' = 'error' AND run.status = 'failed')
    OR (
      run.result_json->>'status' IN ('failed', 'cancelled', 'canceled', 'aborted')
      AND run.status IN ('failed', 'interrupted', 'cancelled')
    )
  );
