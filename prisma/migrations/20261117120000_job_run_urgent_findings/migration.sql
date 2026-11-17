-- Urgent monitor PR-A (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md): durable urgent findings of a monthly-generation run.
-- Additive and nullable: existing rows read NULL; no default, no backfill. Code that does not know the column ignores it.
-- One explicit transaction: `migrate deploy` does not wrap a file, so a failing statement must leave nothing applied.
-- Rollback: deploy the previous code first (it never reads or writes the column), then optionally
--   ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_urgentFindings_object";
--   ALTER TABLE "JobRun" DROP COLUMN "urgentFindings";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117120000_job_run_urgent_findings';
BEGIN;

ALTER TABLE "JobRun" ADD COLUMN "urgentFindings" JSONB;
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_urgentFindings_object"
  CHECK ("urgentFindings" IS NULL OR jsonb_typeof("urgentFindings") = 'object');

COMMIT;
