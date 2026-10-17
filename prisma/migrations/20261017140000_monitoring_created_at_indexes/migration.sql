-- /platform/monitoring (docs/SUPERADMIN_MONITORING_PLAN.md Increment 0) reads platform-wide
-- last-24-hours windows from both tables. Neither table had an index usable for that, and neither
-- is ever pruned, so every page load scanned each table in full. Measured on disposable fixtures
-- (3,000,000 KioskAttempt / 1,000,000 AuditLog rows) in an isolated database: ~200 ms and ~1 GB of
-- pages touched per load before, ~10 ms and ~56 MB after. Evidence:
-- design/matroom/verification/superadmin-monitoring-implementation/README.md.
--
-- Additive only. Plain CREATE INDEX (not CONCURRENTLY) blocks writes to each table while it builds;
-- the 3,000,000-row build above took under one second.

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "KioskAttempt_createdAt_idx" ON "KioskAttempt"("createdAt");
