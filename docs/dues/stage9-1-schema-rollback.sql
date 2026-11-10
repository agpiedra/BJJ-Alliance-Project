-- STAGE 9 PR 9-1 SCHEMA ROLLBACK for migration 20261111120000_dues_activation_record.
--
-- NOT A ROUTINE STEP. Run only with explicit owner approval, by hand (psql), in this order:
--   1. deploy an application build that predates PR 9-1 (old code never reads or writes "DuesActivation", so it runs on either
--      schema);
--   2. then run this script.
-- Never the other way round: PR 9-1 code reads "DuesActivation" on every ledger check and legacy payment, and fails without it.
-- If O4 (20261110120000) must also be rolled back, run THIS script first: 9-1's insert trigger uses O4's
-- dues_marker_absent_on_insert(), which the O4 rollback drops.
--
-- REFUSES once any activation record exists (an approval, a withdrawal or an effective activation): those rows are the record of
-- an owner decision and are never deleted. The check runs under an ACCESS EXCLUSIVE lock, so no row can be inserted between the
-- check and the drop. One explicit transaction: a refusal or failure anywhere leaves the database exactly as it was. This is the
-- only place that edits migration history for 9-1.
--
-- Rehearsed locally (disposable PostgreSQL 17, 2026-11-10): on an empty table the schema dump afterwards equals one migrated only up
-- to O4 (ignoring pg_dump's per-run \restrict token) and `migrate deploy` re-applies 9-1 cleanly; with one row present it
-- refuses and changes nothing.

BEGIN;

LOCK TABLE "DuesActivation" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesActivation") THEN
    RAISE EXCEPTION 'Stage 9 PR 9-1 rollback refused: activation records exist. They are never deleted; use a forward fix.';
  END IF;
END $$;

DROP TABLE "DuesActivation";
DROP FUNCTION dues_activation_set_once();

-- Prisma's own record, so `migrate status` reports the migration as pending again (it would re-apply on the next deploy).
-- (`prisma migrate resolve --rolled-back` cannot do this: it accepts only a FAILED migration.)
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111120000_dues_activation_record';

COMMIT;
