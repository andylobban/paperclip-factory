import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("execution reconciliation hold migration", () => {
  it(
    "repairs same-run blockers and pending deliveries before enforcing uniqueness",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-execution-reconciliation-migration-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
      });
      cleanups.push(async () => sql.end());

      await sql.unsafe(`
        DROP TABLE agent_wakeup_requests CASCADE;
        DROP TABLE issue_recovery_actions CASCADE;
        CREATE TABLE agent_wakeup_requests (
          id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          status text NOT NULL,
          payload jsonb,
          idempotency_key text
        );
        CREATE TABLE issue_recovery_actions (
          id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          source_issue_id uuid NOT NULL,
          status text NOT NULL,
          outcome text,
          resolution_note text,
          next_action text NOT NULL,
          evidence jsonb NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
      `);

      const companyId = "00000000-0000-4000-8000-000000000001";
      const reconciledIssueId = "00000000-0000-4000-8000-000000000002";
      const blockedIssueId = "00000000-0000-4000-8000-000000000003";
      const reconciledRunId = "00000000-0000-4000-8000-000000000004";
      const blockedRunId = "00000000-0000-4000-8000-000000000005";
      const pendingOneId = "00000000-0000-4000-8000-000000000010";
      const pendingWithWakeId = "00000000-0000-4000-8000-000000000011";
      const stoppedDecision = {
        runId: reconciledRunId,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: "The provider stopped before the action was submitted.",
      };
      const rows = [
        {
          id: pendingOneId,
          issueId: reconciledIssueId,
          evidence: {
            runId: reconciledRunId,
            executionReconciliation: stoppedDecision,
            continuationDelivery: "pending",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: pendingWithWakeId,
          issueId: reconciledIssueId,
          evidence: {
            runId: reconciledRunId,
            executionReconciliation: stoppedDecision,
            continuationDelivery: "pending",
          },
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        ...["20", "21"].map((suffix, index) => ({
          id: `00000000-0000-4000-8000-0000000000${suffix}`,
          issueId: reconciledIssueId,
          evidence: {
            runId: reconciledRunId,
            automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
          },
          createdAt: `2026-01-0${index + 3}T00:00:00.000Z`,
        })),
        ...["30", "31"].map((suffix, index) => ({
          id: `00000000-0000-4000-8000-0000000000${suffix}`,
          issueId: blockedIssueId,
          evidence: {
            runId: blockedRunId,
            automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
          },
          createdAt: `2026-02-0${index + 1}T00:00:00.000Z`,
        })),
      ];
      for (const row of rows) {
        await sql`
          INSERT INTO issue_recovery_actions (
            id, company_id, source_issue_id, status, outcome, next_action,
            evidence, created_at, updated_at
          ) VALUES (
            ${row.id}, ${companyId}, ${row.issueId}, 'resolved', 'blocked',
            'Inspect the stopped execution.', ${sql.json(row.evidence)},
            ${row.createdAt}, ${row.createdAt}
          )
        `;
      }
      await sql`
        INSERT INTO agent_wakeup_requests (
          id, company_id, status, payload, idempotency_key
        ) VALUES (
          '00000000-0000-4000-8000-000000000099', ${companyId}, 'queued',
          ${sql.json({ recoveryActionId: pendingWithWakeId })},
          'execution-reconciliation:legacy'
        )
      `;

      const migration = await readFile(
        new URL("./migrations/0286_amused_fabian_cortez.sql", import.meta.url),
        "utf8",
      );
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await sql.unsafe(statement);
      }

      const repaired = await sql<
        Array<{ id: string; evidence: Record<string, unknown> }>
      >`
        SELECT id, evidence
        FROM issue_recovery_actions
        WHERE company_id = ${companyId}
        ORDER BY id
      `;
      const pending = repaired.filter(
        (row) => row.evidence.continuationDelivery === "pending",
      );
      expect(pending.map((row) => row.id)).toEqual([pendingWithWakeId]);
      expect(
        repaired.filter(
          (row) =>
            (row.evidence.automaticRecovery as { replay?: string } | undefined)
              ?.replay === "blocked",
        ),
      ).toHaveLength(1);
      expect(
        repaired.find((row) => row.id === pendingOneId)?.evidence,
      ).toMatchObject({
        continuationDelivery: "invalidated",
        duplicateOfRecoveryActionId: pendingWithWakeId,
      });

      await expect(
        sql`
          INSERT INTO issue_recovery_actions (
            id, company_id, source_issue_id, status, outcome, next_action,
            evidence, created_at, updated_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000032', ${companyId},
            ${blockedIssueId}, 'resolved', 'blocked', 'Duplicate hold',
            ${sql.json({ runId: blockedRunId, automaticRecovery: { replay: "blocked" } })},
            now(), now()
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
