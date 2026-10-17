-- Browser-verification fixtures for alliance_bjj_test ONLY (isolated container, port 5433).
-- Usage: psql -v state=<populated|empty|nohistory|overdue|failed> -f browser-states.sql
-- Every fixture row is tagged (kioskTokenHash / entityId prefix 'browser-fixture') so it can be removed.
\set ON_ERROR_STOP on

DELETE FROM "KioskAttempt" WHERE "kioskTokenHash" = 'browser-fixture';
DELETE FROM "AuditLog" WHERE "entityId" LIKE 'browser-fixture%';
DELETE FROM "JobRun" WHERE "jobName" = 'weekly-digest';

SELECT :'state' = 'populated' AS populated, :'state' = 'empty' AS empty, :'state' = 'nohistory' AS nohistory,
       :'state' = 'overdue' AS overdue, :'state' = 'failed' AS failed \gset

\if :populated
INSERT INTO "KioskAttempt" (id, "academyId", "organizationId", "kioskTokenHash", "ipAddress", success, "countsAsFailure", "createdAt")
SELECT 'bf-ka-' || g, a.id, a."organizationId", 'browser-fixture', '192.0.2.1',
       g <= 41, g > 41 AND g <= 44, now() - (g * interval '25 minutes')
FROM generate_series(1, 50) g, (SELECT id, "organizationId" FROM "Academy" ORDER BY id LIMIT 1) a;
-- 50 rows spread over ~21 hours: 41 success, 3 counted toward PIN limiting, 6 other.
INSERT INTO "KioskAttempt" (id, "academyId", "organizationId", "kioskTokenHash", "ipAddress", success, "countsAsFailure", "createdAt")
SELECT 'bf-ka-old-' || g, a.id, a."organizationId", 'browser-fixture', '192.0.2.1', true, false, now() - interval '30 hours'
FROM generate_series(1, 7) g, (SELECT id, "organizationId" FROM "Academy" ORDER BY id LIMIT 1) a; -- outside the window
INSERT INTO "AuditLog" (id, "organizationId", action, "entityType", "entityId", after, "createdAt")
SELECT 'bf-pay-' || g, a."organizationId", 'duesPayment.record', 'DuesPayment', 'browser-fixture-pay-' || g,
       jsonb_build_object('tenderAmount', 25000), now() - (g * interval '90 minutes')
FROM generate_series(1, 12) g, (SELECT "organizationId" FROM "Academy" ORDER BY id LIMIT 1) a;
INSERT INTO "AuditLog" (id, "actorId", "organizationId", action, "entityType", "entityId", after, "createdAt")
SELECT 'bf-deny-' || g, u.id, a."organizationId", 'organization.accessRefused', 'Organization', 'browser-fixture-deny-' || g,
       jsonb_build_object('reason', 'not_member'), now() - (g * interval '4 hours')
FROM generate_series(1, 3) g, (SELECT "organizationId" FROM "Academy" ORDER BY id LIMIT 1) a,
     (SELECT id FROM "User" WHERE email = 'director@test.com') u;
INSERT INTO "JobRun" (id, "jobName", status, "startedAt", "finishedAt", sent, failed, skipped, "heartbeatStatus")
VALUES ('bf-job-1', 'weekly-digest', 'SUCCEEDED', now() - interval '4 days', now() - interval '4 days' + interval '40 seconds', 3, 0, 0, 'not_configured');
\endif

\if :empty
-- Zero activity in the window; the weekly job still has a run 4 days old (jobs are not windowed).
-- The real UI-generated privileged-change rows are moved outside the window for this state only.
UPDATE "AuditLog" SET "createdAt" = "createdAt" - interval '3 days' WHERE "createdAt" > now() - interval '24 hours';
INSERT INTO "JobRun" (id, "jobName", status, "startedAt", "finishedAt", sent, failed, skipped, "heartbeatStatus")
VALUES ('bf-job-1', 'weekly-digest', 'SUCCEEDED', now() - interval '4 days', now() - interval '4 days' + interval '40 seconds', 3, 0, 0, 'not_configured');
\endif

\if :overdue
INSERT INTO "JobRun" (id, "jobName", status, "startedAt", "finishedAt", sent, failed, skipped, "heartbeatStatus")
VALUES ('bf-job-1', 'weekly-digest', 'SUCCEEDED', now() - interval '9 days', now() - interval '9 days' + interval '40 seconds', 3, 0, 0, 'ok');
\endif

\if :failed
INSERT INTO "JobRun" (id, "jobName", status, "startedAt", "finishedAt", sent, failed, skipped, "heartbeatStatus") VALUES
  ('bf-job-1', 'weekly-digest', 'SUCCEEDED', now() - interval '9 days', now() - interval '9 days' + interval '40 seconds', 3, 0, 0, 'ok'),
  ('bf-job-2', 'weekly-digest', 'FAILED', now() - interval '2 days', now() - interval '2 days' + interval '12 seconds', 0, 3, 0, 'failed');
\endif

SELECT (SELECT count(*) FROM "KioskAttempt" WHERE "createdAt" > now() - interval '24 hours') AS kiosk_24h,
       (SELECT count(*) FROM "AuditLog" WHERE "createdAt" > now() - interval '24 hours') AS audit_24h,
       (SELECT count(*) FROM "JobRun") AS job_runs;
