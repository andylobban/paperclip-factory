import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueScopeCoverageItems = pgTable(
  "issue_scope_coverage_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    key: text("key").notNull(),
    requirement: text("requirement").notNull(),
    required: boolean("required").notNull().default(true),
    ownerIssueId: uuid("owner_issue_id"),
    state: text("state").notNull().default("uncovered"),
    evidence: text("evidence"),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    updatedByActorType: text("updated_by_actor_type").notNull(),
    updatedByActorId: text("updated_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_scope_coverage_issue_company_fk",
    }).onDelete("cascade"),
    ownerIssueCompanyFk: foreignKey({
      columns: [table.companyId, table.ownerIssueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_scope_coverage_owner_issue_company_fk",
    }).onDelete("restrict"),
    issueKeyUq: uniqueIndex("issue_scope_coverage_issue_key_uq").on(
      table.issueId,
      table.key,
    ),
    companyIssueIdx: index("issue_scope_coverage_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
    ownerIssueIdx: index("issue_scope_coverage_owner_issue_idx").on(
      table.companyId,
      table.ownerIssueId,
    ),
    stateCheck: check(
      "issue_scope_coverage_state_check",
      sql`${table.state} in ('uncovered', 'in_progress', 'covered', 'not_applicable')`,
    ),
    actorTypeCheck: check(
      "issue_scope_coverage_actor_type_check",
      sql`${table.createdByActorType} in ('agent', 'user') and ${table.updatedByActorType} in ('agent', 'user')`,
    ),
  }),
);

export const issueCloseoutReviews = pgTable(
  "issue_closeout_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    verdict: text("verdict").notNull(),
    note: text("note"),
    reviewerActorType: text("reviewer_actor_type").notNull(),
    reviewerActorId: text("reviewer_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_closeout_reviews_issue_company_fk",
    }).onDelete("cascade"),
    companyIssueCreatedIdx: index("issue_closeout_reviews_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    verdictCheck: check(
      "issue_closeout_reviews_verdict_check",
      sql`${table.verdict} in ('approved', 'rejected')`,
    ),
    actorTypeCheck: check(
      "issue_closeout_reviews_actor_type_check",
      sql`${table.reviewerActorType} in ('agent', 'user')`,
    ),
  }),
);
