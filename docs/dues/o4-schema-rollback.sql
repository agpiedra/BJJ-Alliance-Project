-- O4 SCHEMA ROLLBACK for migration 20261110120000_dues_prepayment_reversal_cancellation.
--
-- NOT A ROUTINE STEP. Run only with explicit owner approval, AFTER the application has been rolled back to a build that predates
-- O4, and ONLY while no obligation is cancelled and no coverage is released. The script checks that itself, under locks that stop
-- any new cancellation, and refuses otherwise. Once a cancellation exists, use the forward-recovery procedure in
-- docs/DEPLOYMENT_RUNBOOK.md ("O4 prepaid-payment reversal") instead — never this script, never manual edits, never disabled
-- triggers.
--
-- One explicit transaction (Prisma 7.10's `migrate deploy` does not wrap files, and this is run by hand with psql anyway): a
-- failure anywhere leaves the database exactly as it was. Rehearsed locally on 2026-11-09: a database migrated to the head and
-- rolled back with this script has the same schema dump as one migrated only up to 20261109120000.

BEGIN;

-- Stop concurrent writers to the four affected tables for the duration (readers continue).
LOCK TABLE "DuesObligation", "DuesCoverage", "DuesSettlement", "DuesLateFee" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesObligation" WHERE "cancelledAt" IS NOT NULL) OR EXISTS (SELECT 1 FROM "DuesCoverage" WHERE "releasedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'O4 rollback refused: cancelled obligations or released coverage exist. Use the forward-recovery procedure.';
  END IF;
END $$;

-- Indexes back to their original predicates (same names).
DROP INDEX "DuesCoverage_studentId_year_month_key";
CREATE UNIQUE INDEX "DuesCoverage_studentId_year_month_key" ON "DuesCoverage"("studentId", "year", "month");
DROP INDEX "DuesObligation_student_month_monthly_key";
CREATE UNIQUE INDEX "DuesObligation_student_month_monthly_key" ON "DuesObligation"("studentId", "coverageYear", "coverageMonth") WHERE "type" = 'MONTHLY';

-- Triggers added by O4.
DROP TRIGGER "DuesObligation_prepayment_settled_at_creation" ON "DuesObligation";
DROP TRIGGER "DuesCoverage_release_consistent" ON "DuesCoverage";
DROP TRIGGER "DuesObligation_cancellation_consistent" ON "DuesObligation";
DROP TRIGGER "DuesObligation_cancellation_guard" ON "DuesObligation";
DROP TRIGGER "DuesLateFee_obligation_not_cancelled" ON "DuesLateFee";
DROP TRIGGER "DuesSettlement_obligation_not_cancelled" ON "DuesSettlement";
DROP TRIGGER "DuesCoverage_no_marker_on_insert" ON "DuesCoverage";
DROP TRIGGER "DuesObligation_no_marker_on_insert" ON "DuesObligation";

-- Coverage: back to "never updated".
DROP TRIGGER "DuesCoverage_release_once" ON "DuesCoverage";
CREATE TRIGGER "DuesCoverage_no_update" BEFORE UPDATE ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION dues_reject_update();

-- Obligation: back to the original "nothing may change" function (verbatim from 20260927153000_dues_ledger_schema).
CREATE OR REPLACE FUNCTION dues_obligation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'dues_ledger: obligation rows are immutable (nothing, including the due and grace dates, may change)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION dues_prepayment_settled_at_creation();
DROP FUNCTION dues_cancellation_release_consistent();
DROP FUNCTION dues_cancellation_guard();
DROP FUNCTION dues_refuse_cancelled_obligation();
DROP FUNCTION dues_marker_absent_on_insert();
DROP FUNCTION dues_coverage_release_once();

ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_cancellation_marker_complete";
ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_organizationId_cancelledByReversalOfPayment_fkey";
ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_cancelledById_fkey";
ALTER TABLE "DuesObligation" DROP COLUMN "cancellationReason", DROP COLUMN "cancelledAt", DROP COLUMN "cancelledById", DROP COLUMN "cancelledByReversalOfPaymentId";
ALTER TABLE "DuesCoverage" DROP COLUMN "releasedAt";

-- Prisma's own record, so `migrate status` reports the migration as pending again (it would re-apply on the next deploy).
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110120000_dues_prepayment_reversal_cancellation';

COMMIT;
