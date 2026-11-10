-- STAGE 9 PR 9-2 SCHEMA ROLLBACK for migration 20261112120100_dues_opening_obligations_and_o2.
--
-- NOT A ROUTINE STEP. Run only with explicit owner approval, by hand (psql), in this order:
--   1. deploy an application build that predates PR 9-2;
--   2. then run this script.
-- If PR 9-1 or O4 must also be rolled back, run THIS script first (it restores the O4 functions it replaced; then the 9-1
-- script, then the O4 script, as written).
--
-- REFUSES once any OPENING obligation exists (cancelled or not): those rows are financial records and are never deleted.
-- Under that condition every row in the table already satisfies the pre-9-2 constraints restored below. The check runs under
-- a lock that stops new obligations being inserted between the check and the restore.
--
-- The enum value 'OPENING' (migration 20261112120000) STAYS: PostgreSQL cannot drop an enum value without rebuilding the type,
-- and an unused value is inert. That migration's record stays too, so `migrate deploy` will not try to re-add it; only
-- 20261112120100's record is removed (it re-applies on the next deploy). This is the only place that edits migration history
-- for 9-2.

BEGIN;

LOCK TABLE "DuesObligation", "DuesCoverage" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesObligation" WHERE "type" = 'OPENING') THEN
    RAISE EXCEPTION 'Stage 9 PR 9-2 rollback refused: opening obligations exist. They are never deleted; use a forward fix.';
  END IF;
END $$;

-- Coverage trigger and index added by 9-2.
DROP TRIGGER "DuesCoverage_not_opening" ON "DuesCoverage";
DROP FUNCTION dues_coverage_not_opening();
DROP INDEX "DuesObligation_student_month_opening_key";

-- Constraints back to their O4 / enrollment shapes (verbatim from 20261110120000 and 20261001120100).
ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_cancellation_marker_complete";
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_cancellation_marker_complete" CHECK (
  ("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL AND "cancelledByReversalOfPaymentId" IS NULL)
  OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> ''
      AND "cancelledByReversalOfPaymentId" IS NOT NULL AND "type" = 'MONTHLY' AND "origin" = 'PREPAYMENT')
);
ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_shape_by_type";
ALTER TABLE "DuesObligation"
  ADD CONSTRAINT "DuesObligation_shape_by_type" CHECK (
    ("type" = 'MONTHLY' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NOT NULL AND "lateFeeAmount" IS NOT NULL
      AND "policyVersionId" IS NOT NULL AND "graceDeadline" >= "dueOn")
    OR ("type" = 'PACKAGE' AND "monthsCovered" >= 2 AND "dueOn" IS NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL)
    OR ("type" = 'SIGNUP' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL)
  );
ALTER TABLE "DuesObligation" ALTER COLUMN "planTermsId" SET NOT NULL;

-- Functions back to their O4 / ledger-schema bodies (verbatim from 20261110120000 and 20260927153000).
CREATE OR REPLACE FUNCTION dues_obligation_check_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t "PaymentPlanTerms"%ROWTYPE;
  p "DuesPolicyVersion"%ROWTYPE;
  plan_academy text;
BEGIN
  SELECT * INTO t FROM "PaymentPlanTerms" WHERE "id" = NEW."planTermsId" AND "organizationId" = NEW."organizationId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dues_ledger: unknown terms version for this organization' USING ERRCODE = '23503';
  END IF;
  SELECT "academyId" INTO plan_academy FROM "PaymentPlan" WHERE "id" = t."planId" AND "organizationId" = t."organizationId";
  IF plan_academy IS DISTINCT FROM NEW."academyId" THEN
    RAISE EXCEPTION 'dues_ledger: terms version belongs to another branch' USING ERRCODE = '23514';
  END IF;
  IF t."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'dues_ledger: currency does not match its terms version' USING ERRCODE = '23514';
  END IF;
  IF t."monthsCovered" <> NEW."monthsCovered" THEN
    RAISE EXCEPTION 'dues_ledger: duration does not match its terms version' USING ERRCODE = '23514';
  END IF;
  IF NEW."policyVersionId" IS NOT NULL THEN
    SELECT * INTO p FROM "DuesPolicyVersion" WHERE "id" = NEW."policyVersionId" AND "organizationId" = NEW."organizationId" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dues_ledger: unknown policy version for this organization' USING ERRCODE = '23503';
    END IF;
    IF p."academyId" <> NEW."academyId" THEN
      RAISE EXCEPTION 'dues_ledger: policy version belongs to another branch' USING ERRCODE = '23514';
    END IF;
    IF p."lateFeeCurrency" <> NEW."currency" THEN
      RAISE EXCEPTION 'dues_ledger: currency does not match its policy version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dues_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tz text;
  local_now timestamp;
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesSettlement" WHERE "obligationId" = NEW."id" AND "reversedAt" IS NULL) THEN
    RAISE EXCEPTION 'dues_ledger: an obligation with an active settlement cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "DuesLateFee" WHERE "obligationId" = NEW."id") THEN
    RAISE EXCEPTION 'dues_ledger: an obligation with a late fee cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  SELECT a."timezone" INTO tz
    FROM "Student" s JOIN "Academy" a ON a."id" = s."homeAcademyId" AND a."organizationId" = s."organizationId"
    WHERE s."id" = NEW."studentId" AND s."organizationId" = NEW."organizationId";
  IF tz IS NULL THEN
    RAISE EXCEPTION 'dues_ledger: cannot resolve the student''s home-branch timezone for a cancellation' USING ERRCODE = '23514';
  END IF;
  local_now := now() AT TIME ZONE tz;
  IF make_date(NEW."coverageYear", NEW."coverageMonth", 1) <= date_trunc('month', local_now)::date THEN
    RAISE EXCEPTION 'dues_ledger: a month that has already started cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION dues_cancellation_release_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'DuesObligation' THEN
    IF EXISTS (SELECT 1 FROM "DuesCoverage" WHERE "obligationId" = NEW."id" AND "releasedAt" IS NULL) THEN
      RAISE EXCEPTION 'dues_ledger: a cancelled obligation must release all its coverage in the same transaction' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "DuesPayment" WHERE "id" = NEW."cancelledByReversalOfPaymentId" AND "reversedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'dues_ledger: an obligation may be cancelled only by reversing the payment that created it (payment not reversed)' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM "DuesSettlement" WHERE "obligationId" = NEW."id") <> 1
       OR NOT EXISTS (SELECT 1 FROM "DuesSettlement" WHERE "obligationId" = NEW."id" AND "paymentId" = NEW."cancelledByReversalOfPaymentId") THEN
      RAISE EXCEPTION 'dues_ledger: an obligation may be cancelled only by reversing the payment that created it (settlement history)' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "DuesObligation" WHERE "id" = NEW."obligationId" AND "cancelledAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'dues_ledger: coverage may be released only together with its obligation''s cancellation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112120100_dues_opening_obligations_and_o2';

COMMIT;
