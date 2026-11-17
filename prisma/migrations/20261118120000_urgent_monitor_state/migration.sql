-- Urgent monitor PR-B (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md): the monitor's own state. Three NEW tables only; no
-- existing table, column or row is changed. Code that does not know these tables (everything before PR-B) never touches them.
-- One explicit transaction: `migrate deploy` does not wrap a file, so a failing statement must leave nothing applied.
--
-- COMPATIBILITY: additive. Older code runs unchanged against the migrated schema (rehearsed locally). The monitor needs
-- PR-A's "JobRun"."urgentFindings" (migration 20261117120000) to be applied first; it is earlier in this directory.
--
-- ROLLBACK. Step 1 is mandatory in both variants:
-- 1. FIRST deploy code without the urgent monitor (without PR-B; its vercel.json has no monitor cron entry), and wait until no
--    monitor run is in flight (at most 60 s; a crashed run's lease lapses after 125 s). Never drop these tables while the
--    monitor is deployed: every run would fail at its lease.
--
-- 2a. RETAIN the tables (no SQL). Harmless to older code, and nothing is lost. If the monitor is deployed again later, its
--     first run CATCHES UP from the retained state:
--     - slots: every billing slot from the retained "slotCheckedThrough" to now is judged. If billing did not run during the
--       rollback (crons disabled), that is one missed-slot streak covering the whole gap: ONE new alert (SLOT, count = number
--       of slots), not one per slot. If billing ran, those slots are kept.
--     - findings: every finalized monthly-generation run since the retained "watchingSince" that is not in
--       "MonitorProcessedRun" is processed (at most 500 per monitor run, oldest first, none skipped). If PR-A stayed deployed,
--       billing kept writing findings during the rollback, so problems that occurred then are alerted now; problems that have
--       since cleared are reported as cleared occurrences (they still get their alert and one repeat).
--     - pending notifications: every occurrence not yet accepted (first alert) or not yet repeat-accepted is sent on that first
--       run; if "lastReminderAt" is more than 60 min old, the hourly reminder of all unresolved problems is due at once.
--     - M2: "m2LastSignal" may be stale. Set it to 'unknown' before re-enabling, so the first alert re-arms M2:
--         UPDATE "MonitorState" SET "m2LastSignal" = 'unknown' WHERE id = 1;
--     To start fresh instead of catching up (losing the retained state exactly as in 2b, but keeping the tables):
--         DELETE FROM "UrgentAlertKey"; DELETE FROM "MonitorProcessedRun";
--         UPDATE "MonitorState" SET "leaseId" = NULL, "leaseUntil" = NULL, "lastRunEndedAt" = NULL, "watchingSince" = NULL,
--           "slotCheckedThrough" = NULL, "findingsHighWater" = NULL, "m2LastSignal" = 'unknown', "lastReminderAt" = NULL WHERE id = 1;
--
-- 2b. DROP the tables (optional, only after step 1):
--       DROP TABLE "UrgentAlertKey";
--       DROP TABLE "MonitorProcessedRun";
--       DROP TABLE "MonitorState";
--       DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118120000_urgent_monitor_state';
--     DATA LOSS: this permanently deletes every pending and unresolved occurrence, the slot checkpoint, the processed-run
--     ledger and "watchingSince". Occurrences not yet accepted by Healthchecks are then never alerted. If the monitor is
--     re-enabled later, this migration re-creates empty tables and the monitor starts watching anew: billing slots and billing
--     findings from before its new first run are never judged (the findings themselves stay in "JobRun"."urgentFindings").
BEGIN;

CREATE TABLE "MonitorState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastRunEndedAt" TIMESTAMP(3),
    "watchingSince" TIMESTAMP(3),
    "slotCheckedThrough" TIMESTAMP(3),
    "findingsHighWater" TIMESTAMP(3),
    "m2LastSignal" TEXT NOT NULL DEFAULT 'unknown',
    "lastReminderAt" TIMESTAMP(3),
    CONSTRAINT "MonitorState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonitorState_singleton" CHECK ("id" = 1),
    CONSTRAINT "MonitorState_m2LastSignal" CHECK ("m2LastSignal" IN ('success', 'fail', 'unknown'))
);

-- The singleton row the lease updates. Nothing else ever inserts into this table.
INSERT INTO "MonitorState" ("id") VALUES (1);

CREATE TABLE "MonitorProcessedRun" (
    "jobRunId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MonitorProcessedRun_pkey" PRIMARY KEY ("jobRunId")
);

CREATE TABLE "UrgentAlertKey" (
    "key" TEXT NOT NULL,
    "problemKey" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "onsetNotBefore" TIMESTAMP(3),
    "evidenceAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),
    "firstAcceptedAt" TIMESTAMP(3),
    "repeatAcceptedAt" TIMESTAMP(3),
    "lastMissedSlot" TIMESTAMP(3),
    "missedCount" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    CONSTRAINT "UrgentAlertKey_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "UrgentAlertKey_key_shape" CHECK ("key" = "problemKey" || '#' || "occurrence"::text),
    CONSTRAINT "UrgentAlertKey_occurrence" CHECK ("occurrence" >= 1),
    CONSTRAINT "UrgentAlertKey_category" CHECK ("category" IN ('A', 'C', 'SLOT', 'RUNERR', 'RUNDET', 'FAULT')),
    CONSTRAINT "UrgentAlertKey_source" CHECK ("source" IN ('monitorRead', 'billingRun', 'slot', 'monitor')),
    CONSTRAINT "UrgentAlertKey_missedCount" CHECK ("missedCount" >= 1),
    CONSTRAINT "UrgentAlertKey_repeat_after_first" CHECK (
      "repeatAcceptedAt" IS NULL OR ("firstAcceptedAt" IS NOT NULL AND "repeatAcceptedAt" >= "firstAcceptedAt")
    )
);

CREATE UNIQUE INDEX "UrgentAlertKey_problemKey_occurrence_key" ON "UrgentAlertKey"("problemKey", "occurrence");
CREATE INDEX "UrgentAlertKey_clearedAt_repeatAcceptedAt_idx" ON "UrgentAlertKey"("clearedAt", "repeatAcceptedAt");

COMMIT;
