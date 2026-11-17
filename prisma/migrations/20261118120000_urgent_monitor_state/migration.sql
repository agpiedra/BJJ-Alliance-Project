-- Urgent monitor PR-B (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md): the monitor's own state. Two NEW tables only; no
-- existing table, column or row is changed. Code that does not know these tables (everything before PR-B) never touches them.
-- One explicit transaction: `migrate deploy` does not wrap a file, so a failing statement must leave nothing applied.
--
-- COMPATIBILITY: additive. Older code runs unchanged against the migrated schema (rehearsed locally). The monitor needs
-- PR-A's "JobRun"."urgentFindings" (migration 20261117120000) to be applied first; it is earlier in this directory.
--
-- ROLLBACK (order is mandatory):
-- 1. FIRST deploy code without the urgent monitor (without PR-B; its vercel.json has no monitor cron entry), and wait until no
--    monitor run is in flight. Never drop these tables while the monitor is deployed: every run would fail at its lease.
-- 2. Only then, optionally (leaving the tables in place is harmless to older code):
--      DROP TABLE "UrgentAlertKey";
--      DROP TABLE "MonitorState";
--      DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118120000_urgent_monitor_state';
--    DATA LOSS: this permanently deletes every pending and unresolved urgent problem, the slot checkpoint, the findings cursor
--    and `watchingSince`. Problems not yet accepted by Healthchecks are then never alerted. If the monitor is re-enabled later,
--    it starts watching anew: billing slots and billing findings from before its new first run are not judged. The billing
--    findings themselves stay in "JobRun"."urgentFindings" (PR-A) and are not affected.
BEGIN;

CREATE TABLE "MonitorState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastRunEndedAt" TIMESTAMP(3),
    "watchingSince" TIMESTAMP(3),
    "slotCheckedThrough" TIMESTAMP(3),
    "jobRunCursorFinishedAt" TIMESTAMP(3),
    "jobRunCursorId" TEXT,
    "m2LastSignal" TEXT NOT NULL DEFAULT 'unknown',
    "lastReminderAt" TIMESTAMP(3),
    CONSTRAINT "MonitorState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonitorState_singleton" CHECK ("id" = 1),
    CONSTRAINT "MonitorState_m2LastSignal" CHECK ("m2LastSignal" IN ('success', 'fail', 'unknown'))
);

-- The singleton row the lease updates. Nothing else ever inserts into this table.
INSERT INTO "MonitorState" ("id") VALUES (1);

CREATE TABLE "UrgentAlertKey" (
    "key" TEXT NOT NULL,
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
    CONSTRAINT "UrgentAlertKey_category" CHECK ("category" IN ('A', 'C', 'SLOT', 'RUNERR', 'RUNDET', 'FAULT')),
    CONSTRAINT "UrgentAlertKey_source" CHECK ("source" IN ('monitorRead', 'billingRun', 'slot', 'monitor')),
    CONSTRAINT "UrgentAlertKey_missedCount" CHECK ("missedCount" >= 1),
    CONSTRAINT "UrgentAlertKey_repeat_after_first" CHECK (
      "repeatAcceptedAt" IS NULL OR ("firstAcceptedAt" IS NOT NULL AND "repeatAcceptedAt" >= "firstAcceptedAt")
    )
);

CREATE INDEX "UrgentAlertKey_clearedAt_repeatAcceptedAt_idx" ON "UrgentAlertKey"("clearedAt", "repeatAcceptedAt");

COMMIT;
