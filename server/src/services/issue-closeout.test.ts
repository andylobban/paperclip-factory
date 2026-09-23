import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { agents, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { issueCloseoutService } from "./issue-closeout.js";
import { issueService } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("issue closeout scope governance", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not change ordinary leaf issue closure", async () => {
    tempDb ??= await startEmbeddedPostgresTestDatabase("paperclip-closeout-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Leaf closeout",
      issuePrefix: `L${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ordinary leaf",
      status: "todo",
      priority: "medium",
    });

    await expect(issueService(db).update(issueId, { status: "done" }))
      .resolves.toMatchObject({ id: issueId, status: "done" });
  }, 30_000);

  it("does not implicitly enrol a legacy parent from descendant shape", async () => {
    tempDb ??= await startEmbeddedPostgresTestDatabase("paperclip-closeout-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const parentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Legacy parent closeout",
      issuePrefix: `P${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Legacy parent",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issues).values(
      ["First child", "Second child"].map((title) => ({
        id: randomUUID(),
        companyId,
        parentId,
        title,
        status: "done" as const,
        priority: "medium" as const,
      })),
    );

    await expect(issueCloseoutService(db).getDiagnostics(parentId))
      .resolves.toMatchObject({
        governed: false,
        broad: false,
        ready: true,
        reviewRequired: false,
        blockerCodes: [],
      });
    await expect(issueService(db).update(parentId, { status: "done" }))
      .resolves.toMatchObject({ id: parentId, status: "done" });
  }, 30_000);

  it("blocks the AND-517 failure mode until all nine items and independent review are current", async () => {
    tempDb ??= await startEmbeddedPostgresTestDatabase("paperclip-closeout-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const implementerId = randomUUID();
    const reviewerId = randomUUID();
    const parentId = randomUUID();
    const childIds = Array.from({ length: 5 }, () => randomUUID());
    await db.insert(companies).values({
      id: companyId,
      name: "Nine item audit",
      issuePrefix: `N${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: implementerId,
        companyId,
        name: "Implementer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Independent QA",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Nine-item audit and remediation",
      description: "All nine findings must be reconciled before closeout.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: implementerId,
      createdByAgentId: implementerId,
    });
    await db.insert(issues).values(
      childIds.map((id, index) => ({
        id,
        companyId,
        parentId,
        title: `Remediation stream ${index + 1}`,
        status: "done",
        priority: "medium",
        assigneeAgentId: implementerId,
        createdByAgentId: implementerId,
      })),
    );

    const closeout = issueCloseoutService(db);
    const initialItems = Array.from({ length: 9 }, (_, index) => ({
      key: `item-${index + 1}`,
      requirement: `Audit item ${index + 1}`,
      required: true,
      ownerIssueId: childIds[index % childIds.length]!,
      state: index < 5 ? ("covered" as const) : ("in_progress" as const),
      evidence: index < 5 ? `Verified evidence ${index + 1}` : null,
    }));
    const initial = await closeout.upsertCoverage(
      parentId,
      { items: initialItems },
      { type: "agent", id: implementerId },
    );
    expect(initial).toMatchObject({
      governed: true,
      broad: true,
      ready: false,
      requiredItemCount: 9,
      coveredItemCount: 5,
      incompleteItemKeys: ["item-6", "item-7", "item-8", "item-9"],
    });
    await expect(issueService(db).update(parentId, { status: "cancelled" }))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "issue_closeout_blocked",
          diagnostics: {
            blockerCodes: expect.arrayContaining(["coverage_incomplete"]),
          },
        },
      });
    await expect(issueService(db).update(parentId, { status: "done" }))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "issue_closeout_blocked",
          diagnostics: {
            blockerCodes: expect.arrayContaining([
              "coverage_incomplete",
              "independent_review_required",
            ]),
          },
        },
      });

    const completed = await closeout.upsertCoverage(
      parentId,
      {
        items: initialItems.slice(5).map((item, offset) => ({
          ...item,
          state: "covered" as const,
          evidence: `Verified evidence ${offset + 6}`,
        })),
      },
      { type: "agent", id: implementerId },
    );
    expect(completed.blockerCodes).toEqual(["independent_review_required"]);

    await expect(
      closeout.createReview(
        parentId,
        { verdict: "approved", note: "Self approval should fail." },
        { type: "agent", id: implementerId },
      ),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "issue_closeout_reviewer_not_independent" },
    });

    await expect(
      closeout.createReview(
        parentId,
        { verdict: "approved", note: "All nine entries and owners verified." },
        { type: "agent", id: reviewerId },
      ),
    ).resolves.toMatchObject({ verdict: "approved", reviewerActorId: reviewerId });
    await expect(issueService(db).update(parentId, { status: "done" }))
      .resolves.toMatchObject({ id: parentId, status: "done" });
  }, 30_000);

  it("invalidates an approval when the covered scope changes", async () => {
    tempDb ??= await startEmbeddedPostgresTestDatabase("paperclip-closeout-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const implementerId = randomUUID();
    const reviewerId = randomUUID();
    const parentId = randomUUID();
    const childIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Fingerprint invalidation",
      issuePrefix: `F${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: implementerId,
        companyId,
        name: "Implementer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Broad parent",
      status: "todo",
      priority: "medium",
      assigneeAgentId: implementerId,
      createdByAgentId: implementerId,
    });
    await db.insert(issues).values(
      childIds.map((id, index) => ({
        id,
        companyId,
        parentId,
        title: `Child ${index + 1}`,
        status: "done",
        priority: "medium",
        assigneeAgentId: implementerId,
      })),
    );
    const closeout = issueCloseoutService(db);
    const coverage = childIds.map((ownerIssueId, index) => ({
      key: `scope-${index + 1}`,
      requirement: `Scope ${index + 1}`,
      required: true,
      ownerIssueId,
      state: "covered" as const,
      evidence: `Evidence ${index + 1}`,
    }));
    await closeout.upsertCoverage(parentId, { items: coverage }, { type: "agent", id: implementerId });
    const review = await closeout.createReview(
      parentId,
      { verdict: "approved", note: "Verified." },
      { type: "agent", id: reviewerId },
    );
    await closeout.upsertCoverage(
      parentId,
      { items: [{ ...coverage[0]!, evidence: "Stronger replacement evidence" }] },
      { type: "agent", id: implementerId },
    );
    const diagnostics = await closeout.getDiagnostics(parentId);
    expect(diagnostics.fingerprint).not.toBe(review.fingerprint);
    expect(diagnostics.reviewApprovedForFingerprint).toBe(false);
    expect(diagnostics.blockerCodes).toContain("independent_review_required");
  }, 30_000);
});
