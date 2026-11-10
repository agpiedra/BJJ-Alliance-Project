-- Stage 9, PR 9-2: OPENING obligations and O2 (owner cancellation of an erroneous opening obligation).
-- docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md (A2–A4 approved 2026-11-10). One explicit transaction: Prisma's `migrate deploy`
-- does not wrap a file (verified for O4), so a failing statement must leave nothing applied. Nothing in the application
-- creates OPENING rows in this PR (the activation switch does, in PR 9-3).
--
-- O2 reuses O4's cancellation marker, set-once immutability, "no settlement or fee on a cancelled obligation" triggers and
-- deferred consistency check, each widened by type:
--   - MONTHLY + PREPAYMENT (O4): cancelled only by reversing the payment that created it, only before its month starts;
--   - OPENING (O2): cancelled by the owner with a reason, no payment named, refused while any payment is currently applied
--     (A3: a reversed payment no longer blocks). No month-started rule: an opening month is always before S.
BEGIN;

-- 1. Shape. OPENING: one month, no terms, no due or grace date, no fee, no policy (D7, A2); created by the owner's switch.
ALTER TABLE "DuesObligation" ALTER COLUMN "planTermsId" DROP NOT NULL;

ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_shape_by_type";
ALTER TABLE "DuesObligation"
  ADD CONSTRAINT "DuesObligation_shape_by_type" CHECK (
    ("type" = 'MONTHLY' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NOT NULL AND "lateFeeAmount" IS NOT NULL
      AND "policyVersionId" IS NOT NULL AND "graceDeadline" >= "dueOn" AND "planTermsId" IS NOT NULL)
    OR ("type" = 'PACKAGE' AND "monthsCovered" >= 2 AND "dueOn" IS NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL AND "planTermsId" IS NOT NULL)
    OR ("type" = 'SIGNUP' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL AND "planTermsId" IS NOT NULL)
    OR ("type" = 'OPENING' AND "monthsCovered" = 1 AND "dueOn" IS NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL AND "planTermsId" IS NULL AND "origin" = 'STAFF' AND "createdById" IS NOT NULL)
  );

-- At most one live OPENING obligation per student and month (opening items are one per student-month).
CREATE UNIQUE INDEX "DuesObligation_student_month_opening_key" ON "DuesObligation"("studentId", "coverageYear", "coverageMonth")
  WHERE "type" = 'OPENING' AND "cancelledAt" IS NULL;

-- 2. Reference check: an OPENING row references no terms or policy version (the shape CHECK guarantees both are null), so the
--    terms branch/currency/duration checks do not apply to it. Every other type is checked exactly as before.
CREATE OR REPLACE FUNCTION dues_obligation_check_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t "PaymentPlanTerms"%ROWTYPE;
  p "DuesPolicyVersion"%ROWTYPE;
  plan_academy text;
BEGIN
  IF NEW."planTermsId" IS NULL THEN
    IF NEW."type" <> 'OPENING' OR NEW."policyVersionId" IS NOT NULL THEN
      RAISE EXCEPTION 'dues_ledger: only an OPENING obligation has no terms version' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
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

-- 3. An OPENING obligation never claims coverage: months before S are not covered by the ledger.
CREATE FUNCTION dues_coverage_not_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesObligation" WHERE "id" = NEW."obligationId" AND "type" = 'OPENING') THEN
    RAISE EXCEPTION 'dues_ledger: an OPENING obligation never has coverage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DuesCoverage_not_opening" BEFORE INSERT ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION dues_coverage_not_opening();

-- 4. Cancellation marker: the O4 shape, plus the O2 shape (no payment named, OPENING only).
ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_cancellation_marker_complete";
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_cancellation_marker_complete" CHECK (
  ("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL AND "cancelledByReversalOfPaymentId" IS NULL)
  OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> ''
      AND "cancelledByReversalOfPaymentId" IS NOT NULL AND "type" = 'MONTHLY' AND "origin" = 'PREPAYMENT')
  OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> ''
      AND "cancelledByReversalOfPaymentId" IS NULL AND "type" = 'OPENING')
);

-- 5. Cancellation preconditions (immediate, at the cancelling UPDATE). Same function name and trigger as O4, replaced in place:
--    no active settlement and no late-fee row, for every type; the month-started rule only for the O4 (MONTHLY) shape.
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
  IF NEW."type" = 'MONTHLY' THEN
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
  END IF;
  RETURN NULL;
END $$;

-- 6. Consistency at COMMIT (deferred; same function and triggers as O4, replaced in place). Every cancelled obligation must have
--    released all its coverage (an OPENING one has none). Only the O4 shape names a payment, which must be reversed and have
--    been the obligation's only settlement ever. A released coverage row must belong to a cancelled obligation.
CREATE OR REPLACE FUNCTION dues_cancellation_release_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'DuesObligation' THEN
    IF EXISTS (SELECT 1 FROM "DuesCoverage" WHERE "obligationId" = NEW."id" AND "releasedAt" IS NULL) THEN
      RAISE EXCEPTION 'dues_ledger: a cancelled obligation must release all its coverage in the same transaction' USING ERRCODE = '23514';
    END IF;
    IF NEW."cancelledByReversalOfPaymentId" IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM "DuesPayment" WHERE "id" = NEW."cancelledByReversalOfPaymentId" AND "reversedAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'dues_ledger: an obligation may be cancelled only by reversing the payment that created it (payment not reversed)' USING ERRCODE = '23514';
      END IF;
      IF (SELECT count(*) FROM "DuesSettlement" WHERE "obligationId" = NEW."id") <> 1
         OR NOT EXISTS (SELECT 1 FROM "DuesSettlement" WHERE "obligationId" = NEW."id" AND "paymentId" = NEW."cancelledByReversalOfPaymentId") THEN
        RAISE EXCEPTION 'dues_ledger: an obligation may be cancelled only by reversing the payment that created it (settlement history)' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "DuesObligation" WHERE "id" = NEW."obligationId" AND "cancelledAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'dues_ledger: coverage may be released only together with its obligation''s cancellation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
