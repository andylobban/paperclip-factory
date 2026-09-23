CREATE TABLE "issue_closeout_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"reviewer_actor_type" text NOT NULL,
	"reviewer_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_closeout_reviews_verdict_check" CHECK ("issue_closeout_reviews"."verdict" in ('approved', 'rejected')),
	CONSTRAINT "issue_closeout_reviews_actor_type_check" CHECK ("issue_closeout_reviews"."reviewer_actor_type" in ('agent', 'user'))
);
--> statement-breakpoint
CREATE TABLE "issue_scope_coverage_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"key" text NOT NULL,
	"requirement" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"owner_issue_id" uuid,
	"state" text DEFAULT 'uncovered' NOT NULL,
	"evidence" text,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"updated_by_actor_type" text NOT NULL,
	"updated_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_scope_coverage_state_check" CHECK ("issue_scope_coverage_items"."state" in ('uncovered', 'in_progress', 'covered', 'not_applicable')),
	CONSTRAINT "issue_scope_coverage_actor_type_check" CHECK ("issue_scope_coverage_items"."created_by_actor_type" in ('agent', 'user') and "issue_scope_coverage_items"."updated_by_actor_type" in ('agent', 'user'))
);
--> statement-breakpoint
ALTER TABLE "issue_closeout_reviews" ADD CONSTRAINT "issue_closeout_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_closeout_reviews" ADD CONSTRAINT "issue_closeout_reviews_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scope_coverage_items" ADD CONSTRAINT "issue_scope_coverage_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scope_coverage_items" ADD CONSTRAINT "issue_scope_coverage_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scope_coverage_items" ADD CONSTRAINT "issue_scope_coverage_owner_issue_company_fk" FOREIGN KEY ("company_id","owner_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_closeout_reviews_company_issue_created_idx" ON "issue_closeout_reviews" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_scope_coverage_issue_key_uq" ON "issue_scope_coverage_items" USING btree ("issue_id","key");--> statement-breakpoint
CREATE INDEX "issue_scope_coverage_company_issue_idx" ON "issue_scope_coverage_items" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_scope_coverage_owner_issue_idx" ON "issue_scope_coverage_items" USING btree ("company_id","owner_issue_id");