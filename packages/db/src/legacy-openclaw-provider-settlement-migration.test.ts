import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migration = readFileSync(
  new URL(
    "./migrations/0287_legacy_openclaw_provider_settlement.sql",
    import.meta.url,
  ),
  "utf8",
);

(support.supported ? describe : describe.skip)(
  "legacy OpenClaw provider settlement migration",
  () => {
    it("promotes only exact terminal agent.wait receipts and is idempotent", async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "openclaw-settlement-migration-",
      );
      const sql = postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
      });
      try {
        const companyId = randomUUID();
        const openClawAgentId = randomUUID();
        const otherAgentId = randomUUID();
        const exactRunId = randomUUID();
        const mismatchedRunId = randomUUID();
        const timeoutRunId = randomUUID();
        const inconsistentRunId = randomUUID();
        const otherAdapterRunId = randomUUID();
        await sql`INSERT INTO companies (id, name, issue_prefix)
          VALUES (${companyId}, 'Settlement migration', 'OSM')`;
        await sql`INSERT INTO agents (id, company_id, name, adapter_type)
          VALUES
            (${openClawAgentId}, ${companyId}, 'OpenClaw', 'openclaw_gateway'),
            (${otherAgentId}, ${companyId}, 'Other', 'codex_local')`;

        const exact = {
          runId: exactRunId,
          status: "error",
          startedAt: 1791238376137,
          endedAt: 1791238394331,
          error: "Provider returned a terminal error.",
        };
        await sql`INSERT INTO heartbeat_runs
          (id, company_id, agent_id, status, result_json)
          VALUES
            (${exactRunId}, ${companyId}, ${openClawAgentId}, 'failed', ${sql.json(exact)}),
            (${mismatchedRunId}, ${companyId}, ${openClawAgentId}, 'failed', ${sql.json({ ...exact, runId: randomUUID() })}),
            (${timeoutRunId}, ${companyId}, ${openClawAgentId}, 'timed_out', ${sql.json({ runId: timeoutRunId, status: "timeout" })}),
            (${inconsistentRunId}, ${companyId}, ${openClawAgentId}, 'failed', ${sql.json({ ...exact, runId: inconsistentRunId, status: "ok" })}),
            (${otherAdapterRunId}, ${companyId}, ${otherAgentId}, 'failed', ${sql.json({ ...exact, runId: otherAdapterRunId })})`;

        for (let pass = 0; pass < 2; pass += 1) {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await sql.unsafe(statement);
          }
        }

        const rows = await sql<
          Array<{ id: string; result_json: Record<string, unknown> }>
        >`SELECT id, result_json FROM heartbeat_runs
          WHERE id IN (${exactRunId}, ${mismatchedRunId}, ${timeoutRunId}, ${inconsistentRunId}, ${otherAdapterRunId})`;
        const byId = new Map(rows.map((row) => [row.id, row.result_json]));
        expect(byId.get(exactRunId)?.providerSettlement).toEqual({
          state: "terminal",
          runId: exactRunId,
          terminalStatus: "error",
          settledAt: "2026-10-05T22:13:14.331Z",
          source: "agent.wait",
          receipt: exact,
          normalisedFrom: "legacy_top_level_agent_wait",
        });
        for (const runId of [
          mismatchedRunId,
          timeoutRunId,
          inconsistentRunId,
          otherAdapterRunId,
        ]) {
          expect(byId.get(runId)).not.toHaveProperty("providerSettlement");
        }
      } finally {
        await sql.end();
        await database.cleanup();
      }
    }, 60_000);
  },
);
