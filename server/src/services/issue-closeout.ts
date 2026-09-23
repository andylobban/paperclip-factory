import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  issueCloseoutReviews,
  issueAttachments,
  issueScopeCoverageItems,
  issues,
} from "@paperclipai/db";
import type {
  CreateIssueCloseoutReview,
  IssueCloseoutBlockerCode,
  IssueCloseoutDiagnostics,
  IssueCloseoutDescendant,
  UpsertIssueScopeCoverage,
} from "@paperclipai/shared";

import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type CloseoutActor = { type: "agent" | "user"; id: string };
type DbOrTx = Pick<Db, "select" | "insert" | "execute">;

type DescendantRow = IssueCloseoutDescendant & {
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function asNullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function listDescendants(
  dbOrTx: DbOrTx,
  companyId: string,
  issueId: string,
): Promise<DescendantRow[]> {
  const rows = await dbOrTx.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT child.id, child.parent_id, 1 AS depth
      FROM issues child
      WHERE child.company_id = ${companyId}
        AND child.parent_id = ${issueId}
      UNION
      SELECT child.id, child.parent_id, descendants.depth + 1
      FROM issues child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE child.company_id = ${companyId}
        AND descendants.depth < 100
    )
    SELECT
      child.id,
      child.identifier,
      child.title,
      child.status,
      descendants.depth,
      child.created_by_agent_id,
      child.created_by_user_id,
      child.assignee_agent_id,
      child.assignee_user_id
    FROM descendants
    JOIN issues child ON child.id = descendants.id
    ORDER BY descendants.depth ASC, child.created_at ASC, child.id ASC
  `);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      identifier: asNullableString(record.identifier),
      title: String(record.title),
      status: String(record.status) as DescendantRow["status"],
      depth: Number(record.depth),
      createdByAgentId: asNullableString(record.created_by_agent_id),
      createdByUserId: asNullableString(record.created_by_user_id),
      assigneeAgentId: asNullableString(record.assignee_agent_id),
      assigneeUserId: asNullableString(record.assignee_user_id),
    };
  });
}

function closeoutFingerprint(input: {
  issue: { title: string; description: string | null };
  descendants: DescendantRow[];
  coverageItems: Array<typeof issueScopeCoverageItems.$inferSelect>;
}) {
  const canonical = JSON.stringify({
    issue: {
      title: input.issue.title,
      description: input.issue.description,
    },
    descendants: input.descendants.map((item) => ({
      id: item.id,
      status: item.status,
      depth: item.depth,
    })),
    coverageItems: input.coverageItems.map((item) => ({
      key: item.key,
      requirement: item.requirement,
      required: item.required,
      ownerIssueId: item.ownerIssueId,
      state: item.state,
      evidenceAttachmentId: item.evidenceAttachmentId,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function uniqueCodes(codes: IssueCloseoutBlockerCode[]) {
  return [...new Set(codes)];
}

/** Serialize hierarchy mutations that can change a closeout decision. */
export async function lockIssueCloseoutGraph(
  dbOrTx: Pick<Db, "execute">,
  companyId: string,
) {
  await dbOrTx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`issue-closeout-graph:${companyId}`}, 0))`,
  );
}

/** A governed terminal parent must be reopened before its descendants change. */
export async function assertCloseoutAncestorsOpen(
  dbOrTx: Pick<Db, "execute">,
  companyId: string,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const rows = await dbOrTx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT parent.id, parent.parent_id, parent.status, 1 AS depth
      FROM issues parent
      WHERE parent.company_id = ${companyId}
        AND parent.id = ${parentId}
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.status, ancestors.depth + 1
      FROM issues parent
      JOIN ancestors ON parent.id = ancestors.parent_id
      WHERE parent.company_id = ${companyId}
        AND ancestors.depth < 100
    )
    SELECT ancestor.id, ancestor.status
    FROM ancestors ancestor
    WHERE ancestor.status IN ('done', 'cancelled')
      AND EXISTS (
        SELECT 1
        FROM issue_scope_coverage_items coverage
        WHERE coverage.company_id = ${companyId}
          AND coverage.issue_id = ancestor.id
      )
    ORDER BY ancestor.depth ASC
    LIMIT 1
  `);
  const ancestor = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  if (!ancestor) return;
  throw conflict(
    "Reopen the governed parent before changing its descendant scope",
    {
      code: "issue_closeout_parent_terminal",
      parentIssueId: String(ancestor.id),
      parentStatus: String(ancestor.status),
    },
  );
}

export function issueCloseoutService(db: Db) {
  const getDiagnostics = async (
    issueId: string,
    dbOrTx: DbOrTx = db,
  ): Promise<IssueCloseoutDiagnostics> => {
    const issue = await dbOrTx
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const [coverageItems, descendants] = await Promise.all([
      dbOrTx
        .select()
        .from(issueScopeCoverageItems)
        .where(
          and(
            eq(issueScopeCoverageItems.companyId, issue.companyId),
            eq(issueScopeCoverageItems.issueId, issue.id),
          ),
        )
        .orderBy(issueScopeCoverageItems.key),
      listDescendants(dbOrTx, issue.companyId, issue.id),
    ]);
    const evidenceAttachmentIssueIdById = new Map(
      (await dbOrTx
        .select({ id: issueAttachments.id, issueId: issueAttachments.issueId })
        .from(issueAttachments)
        .where(and(
          eq(issueAttachments.companyId, issue.companyId),
          inArray(issueAttachments.issueId, [issue.id, ...descendants.map((item) => item.id)]),
        )))
        .map((attachment) => [attachment.id, attachment.issueId]),
    );
    const fingerprint = closeoutFingerprint({ issue, descendants, coverageItems });
    const latestReview = await dbOrTx
      .select()
      .from(issueCloseoutReviews)
      .where(
        and(
          eq(issueCloseoutReviews.companyId, issue.companyId),
          eq(issueCloseoutReviews.issueId, issue.id),
        ),
      )
      .orderBy(desc(issueCloseoutReviews.createdAt), desc(issueCloseoutReviews.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const requiredItems = coverageItems.filter((item) => item.required);
    const descendantById = new Map(descendants.map((item) => [item.id, item]));
    const activeDescendants = descendants.filter(
      (item) => item.status !== "done" && item.status !== "cancelled",
    );
    const incompleteItemKeys = requiredItems
      .filter((item) => item.state !== "covered")
      .map((item) => item.key);
    const missingEvidenceItemKeys = requiredItems
      .filter(
        (item) =>
          item.state === "covered" &&
          (!item.evidenceAttachmentId ||
            ![issue.id, item.ownerIssueId].includes(
              evidenceAttachmentIssueIdById.get(item.evidenceAttachmentId) ?? null,
            )),
      )
      .map((item) => item.key);
    const missingOwnerItemKeys = requiredItems
      .filter((item) => !item.ownerIssueId)
      .map((item) => item.key);
    const ownerNotDoneItemKeys = requiredItems
      .filter(
        (item) =>
          item.ownerIssueId != null &&
          descendantById.get(item.ownerIssueId)?.status !== "done",
      )
      .map((item) => item.key);

    // Closeout governance is explicitly enrolled by declaring a durable
    // coverage ledger. Descendant shape alone must not change the closure
    // semantics of legacy parents during rollout.
    const governed = coverageItems.length > 0;
    const broad = governed && coverageItems.length >= 2;
    const reviewRequired = broad;
    const reviewApprovedForFingerprint =
      latestReview?.verdict === "approved" &&
      latestReview.fingerprint === fingerprint;
    const blockerCodes: IssueCloseoutBlockerCode[] = [];
    if (governed) {
      if (activeDescendants.length > 0) blockerCodes.push("active_descendants");
      if (requiredItems.length === 0) blockerCodes.push("coverage_required");
      if (incompleteItemKeys.length > 0) blockerCodes.push("coverage_incomplete");
      if (missingEvidenceItemKeys.length > 0)
        blockerCodes.push("coverage_evidence_missing");
      if (missingOwnerItemKeys.length > 0) blockerCodes.push("coverage_owner_missing");
      if (ownerNotDoneItemKeys.length > 0)
        blockerCodes.push("coverage_owner_not_done");
      if (reviewRequired && !reviewApprovedForFingerprint)
        blockerCodes.push("independent_review_required");
    }

    return {
      issueId: issue.id,
      governed,
      broad,
      ready: blockerCodes.length === 0,
      fingerprint,
      requiredItemCount: requiredItems.length,
      coveredItemCount: requiredItems.filter((item) => item.state === "covered").length,
      reviewRequired,
      reviewApprovedForFingerprint,
      blockerCodes: uniqueCodes(blockerCodes),
      incompleteItemKeys,
      missingEvidenceItemKeys,
      missingOwnerItemKeys,
      ownerNotDoneItemKeys,
      activeDescendants: activeDescendants.map(
        ({ id, identifier, title, status, depth }) => ({
          id,
          identifier,
          title,
          status,
          depth,
        }),
      ),
      coverageItems: coverageItems.map((item) => ({
        ...item,
        state: item.state as (typeof coverageItems)[number]["state"] &
          IssueCloseoutDiagnostics["coverageItems"][number]["state"],
        createdByActorType:
          item.createdByActorType as "agent" | "user",
        updatedByActorType:
          item.updatedByActorType as "agent" | "user",
      })),
      latestReview: latestReview
        ? {
            ...latestReview,
            verdict: latestReview.verdict as "approved" | "rejected",
            reviewerActorType:
              latestReview.reviewerActorType as "agent" | "user",
          }
        : null,
    };
  };

  return {
    getDiagnostics,

    upsertCoverage: async (
      issueId: string,
      input: UpsertIssueScopeCoverage,
      actor: CloseoutActor,
    ) =>
      db.transaction(async (tx) => {
        const issueCompany = await tx
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        if (!issueCompany) throw notFound("Issue not found");
        await lockIssueCloseoutGraph(tx, issueCompany.companyId);
        const issue = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");
        if (issue.status === "done" || issue.status === "cancelled") {
          throw conflict("Closed issue scope coverage cannot be changed", {
            code: "issue_closeout_coverage_closed",
          });
        }

        const descendants = await listDescendants(tx, issue.companyId, issue.id);
        const descendantIds = new Set(descendants.map((item) => item.id));
        for (const item of input.items) {
          if (item.required && !item.ownerIssueId) {
            throw unprocessable("Required coverage items need an owning descendant issue", {
              code: "issue_closeout_owner_required",
              itemKey: item.key,
            });
          }
          if (item.ownerIssueId && !descendantIds.has(item.ownerIssueId)) {
            throw unprocessable("Coverage owner must be a descendant of the parent issue", {
              code: "issue_closeout_owner_not_descendant",
              itemKey: item.key,
              ownerIssueId: item.ownerIssueId,
            });
          }
          if (item.state === "covered" && !item.evidenceAttachmentId) {
            throw unprocessable("Covered scope items require evidence", {
              code: "issue_closeout_evidence_required",
              itemKey: item.key,
            });
          }
          if (item.evidenceAttachmentId) {
            const attachment = await tx
              .select({ issueId: issueAttachments.issueId })
              .from(issueAttachments)
              .where(and(
                eq(issueAttachments.companyId, issue.companyId),
                eq(issueAttachments.id, item.evidenceAttachmentId),
              ))
              .then((rows) => rows[0] ?? null);
            if (!attachment || (attachment.issueId !== issue.id && attachment.issueId !== item.ownerIssueId)) {
              throw unprocessable("Evidence must be an attachment on the parent or the item's declared owner", {
                code: "issue_closeout_evidence_not_authorized",
                itemKey: item.key,
              });
            }
          }
        }

        const existingItems = await tx
          .select()
          .from(issueScopeCoverageItems)
          .where(
            and(
              eq(issueScopeCoverageItems.companyId, issue.companyId),
              eq(issueScopeCoverageItems.issueId, issue.id),
            ),
          );
        const existingByKey = new Map(existingItems.map((item) => [item.key, item]));
        for (const item of input.items) {
          if (existingByKey.get(item.key)?.required && !item.required) {
            throw conflict("Required scope coverage entries cannot be downgraded", {
              code: "issue_closeout_required_item_immutable",
              itemKey: item.key,
            });
          }
          await tx
            .insert(issueScopeCoverageItems)
            .values({
              companyId: issue.companyId,
              issueId: issue.id,
              key: item.key,
              requirement: item.requirement,
              required: item.required,
              ownerIssueId: item.ownerIssueId,
              state: item.state,
              evidence: null,
              evidenceAttachmentId: item.evidenceAttachmentId,
              createdByActorType: actor.type,
              createdByActorId: actor.id,
              updatedByActorType: actor.type,
              updatedByActorId: actor.id,
            })
            .onConflictDoUpdate({
              target: [issueScopeCoverageItems.issueId, issueScopeCoverageItems.key],
              set: {
                requirement: item.requirement,
                required: item.required,
                ownerIssueId: item.ownerIssueId,
                state: item.state,
                evidence: null,
                evidenceAttachmentId: item.evidenceAttachmentId,
                updatedByActorType: actor.type,
                updatedByActorId: actor.id,
                updatedAt: new Date(),
              },
            });
        }
        return getDiagnostics(issue.id, tx);
      }),

    createReview: async (
      issueId: string,
      input: CreateIssueCloseoutReview,
      actor: CloseoutActor,
    ) =>
      db.transaction(async (tx) => {
        const issueCompany = await tx
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        if (!issueCompany) throw notFound("Issue not found");
        await lockIssueCloseoutGraph(tx, issueCompany.companyId);
        const issue = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");
        const diagnostics = await getDiagnostics(issue.id, tx);
        if (!diagnostics.reviewRequired) {
          throw unprocessable("This issue does not require an independent closeout review", {
            code: "issue_closeout_review_not_required",
          });
        }

        const descendants = await listDescendants(tx, issue.companyId, issue.id);
        const coverageItems = diagnostics.coverageItems;
        if (input.verdict === "approved") {
          const nonReviewBlockers = diagnostics.blockerCodes.filter(
            (code) => code !== "independent_review_required",
          );
          if (nonReviewBlockers.length > 0) {
            throw conflict("Closeout cannot be approved while scope blockers remain", {
              code: "issue_closeout_not_ready_for_review",
              blockerCodes: nonReviewBlockers,
              diagnostics,
            });
          }

          const conflictingActorIds = new Set<string>();
          if (actor.type === "agent") {
            if (issue.createdByAgentId) conflictingActorIds.add(issue.createdByAgentId);
            if (issue.assigneeAgentId) conflictingActorIds.add(issue.assigneeAgentId);
            for (const item of descendants) {
              if (item.createdByAgentId) conflictingActorIds.add(item.createdByAgentId);
              if (item.assigneeAgentId) conflictingActorIds.add(item.assigneeAgentId);
            }
          } else {
            if (issue.createdByUserId) conflictingActorIds.add(issue.createdByUserId);
            if (issue.assigneeUserId) conflictingActorIds.add(issue.assigneeUserId);
            for (const item of descendants) {
              if (item.createdByUserId) conflictingActorIds.add(item.createdByUserId);
              if (item.assigneeUserId) conflictingActorIds.add(item.assigneeUserId);
            }
          }
          for (const item of coverageItems) {
            if (item.createdByActorType === actor.type)
              conflictingActorIds.add(item.createdByActorId);
            if (item.updatedByActorType === actor.type)
              conflictingActorIds.add(item.updatedByActorId);
          }
          if (conflictingActorIds.has(actor.id)) {
            throw forbidden("Closeout approval requires an independent reviewer", {
              code: "issue_closeout_reviewer_not_independent",
              remediation: "Have a different writer review the complete coverage ledger and descendant state.",
            });
          }
        }

        const [review] = await tx
          .insert(issueCloseoutReviews)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            fingerprint: diagnostics.fingerprint,
            verdict: input.verdict,
            note: input.note?.trim() || null,
            reviewerActorType: actor.type,
            reviewerActorId: actor.id,
          })
          .returning();
        if (!review) throw new Error("issue_closeout_review_not_persisted");
        return {
          ...review,
          verdict: review.verdict as "approved" | "rejected",
          reviewerActorType: review.reviewerActorType as "agent" | "user",
        };
      }),

    assertCanClose: async (issueId: string, dbOrTx: DbOrTx = db) => {
      const diagnostics = await getDiagnostics(issueId, dbOrTx);
      if (!diagnostics.governed || diagnostics.ready) return diagnostics;
      throw conflict("Parent issue cannot close until scope coverage is complete", {
        code: "issue_closeout_blocked",
        diagnostics,
      });
    },
  };
}
