import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { agents, assets, companies, createDb, issueAttachments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { issueCloseoutService } from "./issue-closeout.js";
import { issueService } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

async function createEvidenceAttachment(
  db: ReturnType<typeof createDb>,
  input: { companyId: string; issueId: string; createdByAgentId: string },
) {
  const assetId = randomUUID();
  const attachmentId = randomUUID();
  await db.insert(assets).values({
    id: assetId,
    companyId: input.companyId,
    provider: "test",
    objectKey: `evidence/${assetId}`,
    contentType: "text/plain",
    byteSize: 1,
    sha256: "0".repeat(64),
    createdByAgentId: input.createdByAgentId,
  });
  await db.insert(issueAttachments).values({
    id: attachmentId,
    companyId: input.companyId,
    issueId: input.issueId,
    assetId,
  });
  return attachmentId;
}

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

  it("blocks the original false-completion failure until all nine items and independent review are current", async () => {
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
    const evidenceAttachmentIds = await Promise.all(
      childIds.map((issueId) => createEvidenceAttachment(db, {
        companyId,
        issueId,
        createdByAgentId: implementerId,
      })),
    );
    const initialItems = Array.from({ length: 9 }, (_, index) => ({
      key: `item-${index + 1}`,
      requirement: `Audit item ${index + 1}`,
      required: true,
      ownerIssueId: childIds[index % childIds.length]!,
      state: index < 5 ? ("covered" as const) : ("in_progress" as const),
      evidenceAttachmentId: index < 5 ? evidenceAttachmentIds[index % childIds.length]! : null,
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
          evidenceAttachmentId: evidenceAttachmentIds[(offset + 5) % childIds.length]!,
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
    await expect(
      issueService(db).update(childIds[0]!, { status: "todo" }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "issue_closeout_parent_terminal",
        parentIssueId: parentId,
        parentStatus: "done",
      },
    });
    await expect(
      issueService(db).create(companyId, {
        title: "Late unreviewed scope",
        status: "todo",
        priority: "medium",
        parentId,
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "issue_closeout_parent_terminal",
        parentIssueId: parentId,
      },
    });
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
    const evidenceAttachmentIds = await Promise.all(
      childIds.map((issueId) => createEvidenceAttachment(db, {
        companyId,
        issueId,
        createdByAgentId: implementerId,
      })),
    );
    const coverage = childIds.map((ownerIssueId, index) => ({
      key: `scope-${index + 1}`,
      requirement: `Scope ${index + 1}`,
      required: true,
      ownerIssueId,
      state: "covered" as const,
      evidenceAttachmentId: evidenceAttachmentIds[index]!,
    }));
    await closeout.upsertCoverage(parentId, { items: coverage }, { type: "agent", id: implementerId });
    const review = await closeout.createReview(
      parentId,
      { verdict: "approved", note: "Verified." },
      { type: "agent", id: reviewerId },
    );
    await closeout.upsertCoverage(
      parentId,
      { items: [{ ...coverage[0]!, evidenceAttachmentId: evidenceAttachmentIds[1]! }] },
      { type: "agent", id: implementerId },
    );
    const diagnostics = await closeout.getDiagnostics(parentId);
    expect(diagnostics.fingerprint).not.toBe(review.fingerprint);
    expect(diagnostics.reviewApprovedForFingerprint).toBe(false);
    expect(diagnostics.blockerCodes).toContain("independent_review_required");
  }, 30_000);

  it("accepts only live parent-or-descendant evidence attachments", async () => {
    tempDb ??= await startEmbeddedPostgresTestDatabase("paperclip-closeout-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const implementerId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const unrelatedId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Evidence company", issuePrefix: `E${companyId.slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other evidence company", issuePrefix: `O${otherCompanyId.slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values({
      id: implementerId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Evidence parent", status: "in_progress", priority: "high", assigneeAgentId: implementerId, createdByAgentId: implementerId },
      { id: childId, companyId, parentId, title: "Evidence child", status: "done", priority: "medium", assigneeAgentId: implementerId },
      { id: unrelatedId, companyId, title: "Unrelated issue", status: "done", priority: "medium", assigneeAgentId: implementerId },
      { id: otherIssueId, companyId: otherCompanyId, title: "Other company issue", status: "done", priority: "medium" },
    ]);
    const closeout = issueCloseoutService(db);
    const parentAttachmentId = await createEvidenceAttachment(db, { companyId, issueId: parentId, createdByAgentId: implementerId });
    const childAttachmentId = await createEvidenceAttachment(db, { companyId, issueId: childId, createdByAgentId: implementerId });
    const unrelatedAttachmentId = await createEvidenceAttachment(db, { companyId, issueId: unrelatedId, createdByAgentId: implementerId });
    const otherCompanyAttachmentId = await createEvidenceAttachment(db, { companyId: otherCompanyId, issueId: otherIssueId, createdByAgentId: implementerId });
    const actor = { type: "agent" as const, id: implementerId };
    const item = { key: "evidence", requirement: "Evidence", required: true, ownerIssueId: childId, state: "covered" as const };

    await expect(closeout.upsertCoverage(parentId, { items: [{ ...item, evidenceAttachmentId: parentAttachmentId }] }, actor))
      .resolves.toMatchObject({ ready: true, missingEvidenceItemKeys: [] });
    await expect(closeout.upsertCoverage(parentId, { items: [{ ...item, evidenceAttachmentId: childAttachmentId }] }, actor))
      .resolves.toMatchObject({ ready: true, missingEvidenceItemKeys: [] });
    await expect(closeout.upsertCoverage(parentId, { items: [{ ...item, evidence: "legacy text" } as any] }, actor))
      .rejects.toMatchObject({ status: 422, details: { code: "issue_closeout_evidence_required" } });
    await expect(closeout.upsertCoverage(parentId, { items: [{ ...item, evidenceAttachmentId: unrelatedAttachmentId }] }, actor))
      .rejects.toMatchObject({ status: 422, details: { code: "issue_closeout_evidence_not_authorized" } });
    await expect(closeout.upsertCoverage(parentId, { items: [{ ...item, evidenceAttachmentId: otherCompanyAttachmentId }] }, actor))
      .rejects.toMatchObject({ status: 422, details: { code: "issue_closeout_evidence_not_authorized" } });

    await db.delete(issueAttachments).where(eq(issueAttachments.id, childAttachmentId));
    await expect(closeout.getDiagnostics(parentId)).resolves.toMatchObject({
      ready: false,
      missingEvidenceItemKeys: ["evidence"],
      blockerCodes: expect.arrayContaining(["coverage_evidence_missing"]),
    });
    await expect(issueService(db).update(parentId, { status: "done" }))
      .rejects.toMatchObject({ status: 409, details: { code: "issue_closeout_blocked" } });
  }, 30_000);
});
