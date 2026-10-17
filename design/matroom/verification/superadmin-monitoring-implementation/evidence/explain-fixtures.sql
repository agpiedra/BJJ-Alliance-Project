-- Disposable volume fixtures for monitoring_explain_test ONLY (isolated test container, port 5433).
-- Assumed scale: ~50 academies x ~150 kiosk attempts/day and ~2,500 audit rows/day platform-wide,
-- retained ~400 days (no retention cleanup exists) => 3,000,000 KioskAttempt + 1,000,000 AuditLog rows.
\set ON_ERROR_STOP on
SET synchronous_commit = off;

CREATE TEMP TABLE academies AS SELECT row_number() OVER () AS n, id, "organizationId" FROM "Academy";
CREATE TEMP TABLE orgs AS SELECT row_number() OVER () AS n, id FROM "Organization";

INSERT INTO "KioskAttempt" (id, "academyId", "organizationId", "kioskTokenHash", "ipAddress", success, "countsAsFailure", "createdAt")
SELECT md5(g::text || random()::text), a.id, a."organizationId", md5(a.id), '198.51.100.' || (g % 250),
       r < 0.85, r >= 0.85 AND r < 0.92, now() - (random() * interval '400 days')
FROM generate_series(1, 3000000) AS g
CROSS JOIN LATERAL (SELECT random() + 0 * g AS r) rr
JOIN academies a ON a.n = 1 + (g % (SELECT count(*) FROM academies));

INSERT INTO "AuditLog" (id, "actorId", "organizationId", action, "entityType", "entityId", after, "createdAt")
SELECT md5(g::text || random()::text), NULL, o.id,
       CASE
         WHEN r < 0.35 THEN 'duesPayment.record'
         WHEN r < 0.355 THEN 'organization.accessRefused'
         WHEN r < 0.357 THEN (ARRAY['organization.approve','organization.suspend','organizationInvoice.create','organizationInvoice.recordPayment','organization.reactivate'])[1 + (g % 5)]
         WHEN r < 0.6 THEN 'attendance.record'
         WHEN r < 0.8 THEN 'student.update'
         ELSE 'duesObligation.generate'
       END,
       'Entity', md5(g::text), jsonb_build_object('n', g), now() - (random() * interval '400 days')
FROM generate_series(1, 1000000) AS g
CROSS JOIN LATERAL (SELECT random() + 0 * g AS r) rr
JOIN orgs o ON o.n = 1 + (g % (SELECT count(*) FROM orgs));

ANALYZE "KioskAttempt";
ANALYZE "AuditLog";
SELECT 'KioskAttempt' AS t, count(*) FROM "KioskAttempt" UNION ALL SELECT 'AuditLog', count(*) FROM "AuditLog";
