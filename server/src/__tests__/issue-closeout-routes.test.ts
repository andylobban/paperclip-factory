import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agents, companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, companyId: string, userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [
        { companyId, membershipRole: "operator", status: "active" },
      ],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("issue closeout routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-closeout-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exposes missing coverage, accepts evidence, and records a review", async () => {
    const companyId = randomUUID();
    const implementerId = randomUUID();
    const parentId = randomUUID();
    const childIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Closeout routes",
      issuePrefix: `CR${companyId.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "independent-reviewer",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: implementerId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Broad parent",
      status: "in_review",
      priority: "high",
      assigneeAgentId: implementerId,
      createdByAgentId: implementerId,
      responsibleUserId: "independent-reviewer",
    });
    await db.insert(issues).values(
      childIds.map((id, index) => ({
        id,
        companyId,
        parentId,
        title: `Scope ${index + 1}`,
        status: "done",
        priority: "medium",
        assigneeAgentId: implementerId,
        createdByAgentId: implementerId,
      })),
    );
    const coverageApp = createApp(db, companyId, "scope-writer");
    const reviewApp = createApp(db, companyId, "independent-reviewer");

    const missing = await request(coverageApp).get(
      `/api/issues/${parentId}/diagnostics/closeout`,
    );
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    expect(missing.body).toMatchObject({
      broad: true,
      ready: false,
      blockerCodes: expect.arrayContaining([
        "coverage_required",
        "independent_review_required",
      ]),
    });

    const coverage = await request(coverageApp)
      .put(`/api/issues/${parentId}/closeout/coverage`)
      .send({
        items: childIds.map((ownerIssueId, index) => ({
          key: `item-${index + 1}`,
          requirement: `Scope item ${index + 1}`,
          ownerIssueId,
          state: "covered",
          evidence: `Evidence ${index + 1}`,
        })),
      });
    expect(coverage.status, JSON.stringify(coverage.body)).toBe(200);
    expect(coverage.body).toMatchObject({
      ready: false,
      blockerCodes: ["independent_review_required"],
    });

    const review = await request(reviewApp)
      .post(`/api/issues/${parentId}/closeout/reviews`)
      .send({ verdict: "approved", note: "All scope entries verified." });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    expect(review.body).toMatchObject({
      verdict: "approved",
      reviewerActorType: "user",
      reviewerActorId: "independent-reviewer",
    });

    const ready = await request(reviewApp).get(
      `/api/issues/${parentId}/diagnostics/closeout`,
    );
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({
      ready: true,
      reviewApprovedForFingerprint: true,
      blockerCodes: [],
    });
  }, 30_000);
});
