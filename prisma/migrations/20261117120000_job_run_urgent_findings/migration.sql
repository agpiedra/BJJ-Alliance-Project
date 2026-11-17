-- Urgent monitor PR-A (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md): durable urgent findings of a monthly-generation run.
-- Additive and nullable: existing rows read NULL; no default, no backfill. Code that does not know the column ignores it.
-- One explicit transaction: `migrate deploy` does not wrap a file, so a failing statement must leave nothing applied.
--
-- ROLLBACK (order is mandatory):
-- 1. FIRST deploy code that neither writes nor reads "urgentFindings": code from before this migration's PR (urgent monitor
--    PR-A) AND without the urgent monitor (PR-B, which reads it). Wait until no run of the newer code is in flight.
--    Never drop the column while code that writes it is deployed: every monthly-generation run's finalize update would fail,
--    so every run would end unfinalized (HTTP 500, scheduler /fail, and a missed slot for the monitor).
-- 2. Only then, optionally (leaving the column in place is harmless to the older code):
--      ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_urgentFindings_object";
--      ALTER TABLE "JobRun" DROP COLUMN "urgentFindings";
--      DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117120000_job_run_urgent_findings';
--    DATA LOSS: dropping the column permanently deletes every stored urgent finding. Findings are written nowhere else, so
--    urgent problems they recorded (for example during a monitor outage) can no longer be recovered. Export them first if
--    they may still be needed: SELECT id, "finishedAt", "urgentFindings" FROM "JobRun" WHERE "urgentFindings" IS NOT NULL;
BEGIN;

ALTER TABLE "JobRun" ADD COLUMN "urgentFindings" JSONB;
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_urgentFindings_object"
  CHECK ("urgentFindings" IS NULL OR jsonb_typeof("urgentFindings") = 'object');

COMMIT;
