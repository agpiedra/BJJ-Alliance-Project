-- Monthly-generation four-check alerting (docs/dues/MONTHLY-GENERATION-ALERTING-PLAN.md §3).
-- Additive and nullable: existing rows read NULL; no default, no backfill.
-- Rollback: revert the code that writes it first; the column can then stay (ignored) or be dropped with
--   ALTER TABLE "JobRun" DROP COLUMN "alertPings";
ALTER TABLE "JobRun" ADD COLUMN "alertPings" JSONB;
