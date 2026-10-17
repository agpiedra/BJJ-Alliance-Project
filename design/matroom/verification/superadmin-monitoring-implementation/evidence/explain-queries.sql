-- The exact statements Prisma issued (captured from the Postgres statement log), parameters inlined.
\set ON_ERROR_STOP on
\pset pager off
\set s '''2026-10-16 13:49:03.445'''
\set e '''2026-10-17 13:49:03.445'''
\echo === kiosk groupBy
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT COUNT(*) AS "_count$_all", "public"."KioskAttempt"."success", "public"."KioskAttempt"."countsAsFailure" FROM "public"."KioskAttempt" WHERE ("public"."KioskAttempt"."createdAt" >= :s AND "public"."KioskAttempt"."createdAt" <= :e) GROUP BY "public"."KioskAttempt"."success", "public"."KioskAttempt"."countsAsFailure" OFFSET 0;
\echo === payment count
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."AuditLog"."id" FROM "public"."AuditLog" WHERE ("public"."AuditLog"."action" = 'duesPayment.record' AND "public"."AuditLog"."createdAt" >= :s AND "public"."AuditLog"."createdAt" <= :e) OFFSET 0) AS "sub";
\echo === access denials list
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT "public"."AuditLog"."id", "public"."AuditLog"."action", "public"."AuditLog"."createdAt", "public"."AuditLog"."actorId", "public"."AuditLog"."entityType", "public"."AuditLog"."entityId", "public"."AuditLog"."organizationId" FROM "public"."AuditLog" WHERE ("public"."AuditLog"."action" IN ('organization.accessRefused') AND "public"."AuditLog"."createdAt" >= :s AND "public"."AuditLog"."createdAt" <= :e) ORDER BY "public"."AuditLog"."createdAt" DESC, "public"."AuditLog"."id" DESC LIMIT 50 OFFSET 0;
\echo === privileged list
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT "public"."AuditLog"."id", "public"."AuditLog"."action", "public"."AuditLog"."createdAt", "public"."AuditLog"."actorId", "public"."AuditLog"."entityType", "public"."AuditLog"."entityId", "public"."AuditLog"."organizationId" FROM "public"."AuditLog" WHERE ("public"."AuditLog"."action" IN ('organization.approve','organization.reject','organization.suspend','organization.cancel','organization.reactivate','organization.createManual','organization.graceDays.changed','organizationInvoice.create','organizationInvoice.recordPayment','organizationInvoice.void','organizationInvoice.acknowledgeReview','organizationInvoice.graceExtended','user.superAdminGranted','user.superAdminRevoked') AND "public"."AuditLog"."createdAt" >= :s AND "public"."AuditLog"."createdAt" <= :e) ORDER BY "public"."AuditLog"."createdAt" DESC, "public"."AuditLog"."id" DESC LIMIT 50 OFFSET 0;
