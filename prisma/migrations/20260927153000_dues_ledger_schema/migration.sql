-- CreateEnum
CREATE TYPE "DuesObligationType" AS ENUM ('MONTHLY', 'PACKAGE');

-- CreateEnum
CREATE TYPE "DuesObligationOrigin" AS ENUM ('SCHEDULED_JOB', 'PREPAYMENT', 'STAFF');

-- CreateEnum
CREATE TYPE "DuesLateFeeRemovalKind" AS ENUM ('WAIVED', 'VOIDED');

-- CreateTable
CREATE TABLE "DuesObligation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "type" "DuesObligationType" NOT NULL,
    "origin" "DuesObligationOrigin" NOT NULL,
    "coverageYear" INTEGER NOT NULL,
    "coverageMonth" INTEGER NOT NULL,
    "monthsCovered" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "lateFeeAmount" DECIMAL(10,2),
    "dueOn" DATE,
    "graceDeadline" DATE,
    "planTermsId" TEXT NOT NULL,
    "policyVersionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuesObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuesCoverage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,

    CONSTRAINT "DuesCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuesLateFee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "obligationType" "DuesObligationType" NOT NULL DEFAULT 'MONTHLY',
    "assessableFrom" DATE NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removalKind" "DuesLateFeeRemovalKind",
    "removedById" TEXT,
    "removalReason" TEXT,

    CONSTRAINT "DuesLateFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuesPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "tenderCurrency" "Currency" NOT NULL,
    "tenderAmount" DECIMAL(10,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "DuesPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuesSettlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "lateFeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "DuesSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DuesObligation_organizationId_idx" ON "DuesObligation"("organizationId");

-- CreateIndex
CREATE INDEX "DuesObligation_studentId_coverageYear_coverageMonth_idx" ON "DuesObligation"("studentId", "coverageYear", "coverageMonth");

-- CreateIndex
CREATE INDEX "DuesObligation_planTermsId_idx" ON "DuesObligation"("planTermsId");

-- CreateIndex
CREATE INDEX "DuesObligation_policyVersionId_idx" ON "DuesObligation"("policyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesObligation_organizationId_id_key" ON "DuesObligation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DuesObligation_organizationId_id_studentId_key" ON "DuesObligation"("organizationId", "id", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesObligation_organizationId_id_type_key" ON "DuesObligation"("organizationId", "id", "type");

-- CreateIndex
CREATE INDEX "DuesCoverage_organizationId_idx" ON "DuesCoverage"("organizationId");

-- CreateIndex
CREATE INDEX "DuesCoverage_obligationId_idx" ON "DuesCoverage"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesCoverage_studentId_year_month_key" ON "DuesCoverage"("studentId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "DuesLateFee_obligationId_key" ON "DuesLateFee"("obligationId");

-- CreateIndex
CREATE INDEX "DuesLateFee_organizationId_idx" ON "DuesLateFee"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesLateFee_organizationId_id_obligationId_key" ON "DuesLateFee"("organizationId", "id", "obligationId");

-- CreateIndex
CREATE INDEX "DuesPayment_organizationId_idx" ON "DuesPayment"("organizationId");

-- CreateIndex
CREATE INDEX "DuesPayment_studentId_receivedOn_idx" ON "DuesPayment"("studentId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPayment_organizationId_id_studentId_key" ON "DuesPayment"("organizationId", "id", "studentId");

-- CreateIndex
CREATE INDEX "DuesSettlement_organizationId_idx" ON "DuesSettlement"("organizationId");

-- CreateIndex
CREATE INDEX "DuesSettlement_paymentId_idx" ON "DuesSettlement"("paymentId");

-- CreateIndex
CREATE INDEX "DuesSettlement_obligationId_idx" ON "DuesSettlement"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPolicyVersion_organizationId_id_key" ON "DuesPolicyVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlanTerms_organizationId_id_key" ON "PaymentPlanTerms"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_planTermsId_fkey" FOREIGN KEY ("organizationId", "planTermsId") REFERENCES "PaymentPlanTerms"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_policyVersionId_fkey" FOREIGN KEY ("organizationId", "policyVersionId") REFERENCES "DuesPolicyVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesCoverage" ADD CONSTRAINT "DuesCoverage_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesCoverage" ADD CONSTRAINT "DuesCoverage_organizationId_obligationId_studentId_fkey" FOREIGN KEY ("organizationId", "obligationId", "studentId") REFERENCES "DuesObligation"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesCoverage" ADD CONSTRAINT "DuesCoverage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesLateFee" ADD CONSTRAINT "DuesLateFee_organizationId_obligationId_obligationType_fkey" FOREIGN KEY ("organizationId", "obligationId", "obligationType") REFERENCES "DuesObligation"("organizationId", "id", "type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesLateFee" ADD CONSTRAINT "DuesLateFee_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesLateFee" ADD CONSTRAINT "DuesLateFee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesSettlement" ADD CONSTRAINT "DuesSettlement_organizationId_paymentId_studentId_fkey" FOREIGN KEY ("organizationId", "paymentId", "studentId") REFERENCES "DuesPayment"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesSettlement" ADD CONSTRAINT "DuesSettlement_organizationId_obligationId_studentId_fkey" FOREIGN KEY ("organizationId", "obligationId", "studentId") REFERENCES "DuesObligation"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesSettlement" ADD CONSTRAINT "DuesSettlement_organizationId_lateFeeId_obligationId_fkey" FOREIGN KEY ("organizationId", "lateFeeId", "obligationId") REFERENCES "DuesLateFee"("organizationId", "id", "obligationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesSettlement" ADD CONSTRAINT "DuesSettlement_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesSettlement" ADD CONSTRAINT "DuesSettlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------------------------
-- Hand-written part. Prisma's schema language cannot express CHECK constraints, partial unique indexes or triggers, so this migration is
-- their source of truth (documented in schema.prisma above DuesObligation; proved by tests/integration/dues-ledger-schema.test.ts).
-- Nothing below touches a legacy table (PaymentPeriod, PaymentPlan) or any existing row. The only objects added on existing tables are the
-- two unique indexes above and the two protection triggers on PaymentPlanTerms and DuesPolicyVersion.
-- ---------------------------------------------------------------------------------------------------------------------------------

-- CHECK constraints ------------------------------------------------------------------------------------------------------------------
-- Year 2000 to 2100 is the same typo guard the configuration tables use, not a business rule.

ALTER TABLE "DuesObligation"
  ADD CONSTRAINT "DuesObligation_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "DuesObligation_coverage_month_valid" CHECK ("coverageMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesObligation_coverage_year_sane" CHECK ("coverageYear" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "DuesObligation_late_fee_non_negative" CHECK ("lateFeeAmount" IS NULL OR "lateFeeAmount" >= 0),
  ADD CONSTRAINT "DuesObligation_shape_by_type" CHECK (
    ("type" = 'MONTHLY' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NOT NULL AND "lateFeeAmount" IS NOT NULL
      AND "policyVersionId" IS NOT NULL AND "graceDeadline" >= "dueOn")
    OR ("type" = 'PACKAGE' AND "monthsCovered" >= 2 AND "dueOn" IS NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL)
  );

ALTER TABLE "DuesCoverage"
  ADD CONSTRAINT "DuesCoverage_month_valid" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesCoverage_year_sane" CHECK ("year" BETWEEN 2000 AND 2100);

ALTER TABLE "DuesLateFee"
  ADD CONSTRAINT "DuesLateFee_only_monthly" CHECK ("obligationType" = 'MONTHLY'),
  ADD CONSTRAINT "DuesLateFee_removal_marker_complete" CHECK (
    ("removedAt" IS NULL AND "removalKind" IS NULL AND "removedById" IS NULL AND "removalReason" IS NULL)
    OR ("removedAt" IS NOT NULL AND "removalKind" IS NOT NULL AND "removedById" IS NOT NULL AND "removalReason" IS NOT NULL AND btrim("removalReason") <> '')
  );

ALTER TABLE "DuesPayment"
  ADD CONSTRAINT "DuesPayment_tender_positive" CHECK ("tenderAmount" > 0),
  ADD CONSTRAINT "DuesPayment_reversal_marker_complete" CHECK (
    ("reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL)
    OR ("reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND "reversalReason" IS NOT NULL AND btrim("reversalReason") <> '')
  );

ALTER TABLE "DuesSettlement"
  ADD CONSTRAINT "DuesSettlement_reversal_marker_complete" CHECK (
    ("reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL)
    OR ("reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND "reversalReason" IS NOT NULL AND btrim("reversalReason") <> '')
  );

-- Partial unique indexes --------------------------------------------------------------------------------------------------------------

-- The confirmed monthly identity: one MONTHLY obligation per student per coverage month (prepaid months included).
CREATE UNIQUE INDEX "DuesObligation_student_month_monthly_key" ON "DuesObligation"("studentId", "coverageYear", "coverageMonth") WHERE "type" = 'MONTHLY';

-- At most ONE ACTIVE settlement per obligation. A reversed settlement (marker set) stays as history and no longer counts, so the
-- obligation can be settled again by a new row; two active rows can never coexist, including under concurrent inserts.
CREATE UNIQUE INDEX "DuesSettlement_one_active_per_obligation_key" ON "DuesSettlement"("obligationId") WHERE "reversedAt" IS NULL;

-- Permanent history -------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION dues_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dues_ledger: rows are never deleted (%)', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE FUNCTION dues_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dues_ledger: coverage rows are never updated' USING ERRCODE = '23514';
END $$;

-- The only permitted UPDATE of a payment, settlement or fee: set its marker once, from all-null, changing nothing else. TG_ARGV[0] names
-- the marker for the message, TG_ARGV[1] lists its columns. Completeness (all set, non-blank reason) is the CHECK constraints' job.
-- BEFORE ROW triggers see the latest committed version of the row after a concurrent update, so two simultaneous reversals cannot both
-- pass. This does NOT make a payment's reversal and its settlements' reversals atomic: they are separate rows and the writer must set
-- them in one transaction.
CREATE FUNCTION dues_set_once_marker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  word text := TG_ARGV[0];
  cols text[] := string_to_array(TG_ARGV[1], ',');
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
  c text;
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF old_j -> c <> 'null'::jsonb THEN
      RAISE EXCEPTION 'dues_ledger: only the % marker may be set, once (it is already set)', word USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF (new_j - cols) IS DISTINCT FROM (old_j - cols) THEN
    RAISE EXCEPTION 'dues_ledger: only the % marker may be set, once (no other column may change)', word USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- An obligation's snapshot never changes. Its due and grace dates are the only exception: rescheduling is decided later (D5) and will
-- be an audited action.
CREATE FUNCTION dues_obligation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'dueOn' - 'graceDeadline') IS DISTINCT FROM (to_jsonb(OLD) - 'dueOn' - 'graceDeadline') THEN
    RAISE EXCEPTION 'dues_ledger: obligation fields other than the due and grace dates are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DuesObligation_no_delete" BEFORE DELETE ON "DuesObligation" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesCoverage_no_delete" BEFORE DELETE ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesLateFee_no_delete" BEFORE DELETE ON "DuesLateFee" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesPayment_no_delete" BEFORE DELETE ON "DuesPayment" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesSettlement_no_delete" BEFORE DELETE ON "DuesSettlement" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();

CREATE TRIGGER "DuesCoverage_no_update" BEFORE UPDATE ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION dues_reject_update();
CREATE TRIGGER "DuesObligation_immutable" BEFORE UPDATE ON "DuesObligation" FOR EACH ROW EXECUTE FUNCTION dues_obligation_immutable();
CREATE TRIGGER "DuesPayment_marker_once" BEFORE UPDATE ON "DuesPayment" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('reversal', 'reversedAt,reversedById,reversalReason');
CREATE TRIGGER "DuesSettlement_marker_once" BEFORE UPDATE ON "DuesSettlement" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('reversal', 'reversedAt,reversedById,reversalReason');
CREATE TRIGGER "DuesLateFee_marker_once" BEFORE UPDATE ON "DuesLateFee" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('removal', 'removedAt,removalKind,removedById,removalReason');

-- Referenced configuration versions --------------------------------------------------------------------------------------------------
-- D25 lets an owner correct a future-effective PaymentPlanTerms or DuesPolicyVersion row in place. A future prepayment can reference such a
-- row, so the database protects it, race-free:
--
-- (1) An obligation INSERT locks the version row it references (FOR SHARE) BEFORE the row exists and checks that it agrees with the
--     version's branch, currency and duration. A correction UPDATE takes the conflicting row lock and only then looks for references
--     (PostgreSQL locks the row before a BEFORE ROW trigger runs; the explicit FOR UPDATE in the guards is belt and braces, independent
--     of that executor detail, and the concurrency tests pass with or without it). Those locks conflict, so the two statements are
--     serialized whichever starts first. The obligation-side FOR SHARE is the part that is NOT redundant (removing it fails the tests):
--       - reference first: the correction waits for the obligation's transaction to end, then sees the committed reference and is refused;
--       - correction first: the obligation waits for the correction to commit, then reads the CORRECTED row and is refused if it no longer
--         agrees (currency or duration changed).
--     A check that only looked for existing references would miss an uncommitted one.
-- (2) DELETE of a referenced version is refused by the restrict foreign key, which takes the same kind of row lock.
--
-- Limits, stated plainly: the amount and fee amount are NOT compared (they may differ by exception, D8), so a writer must SELECT the
-- version FOR SHARE before reading its price and in the same transaction as the obligation insert, or it can snapshot a price a
-- concurrent correction is about to change. An UPDATE of a referenced version is refused whatever it changes.

CREATE FUNCTION dues_obligation_check_references() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE FUNCTION dues_terms_referenced_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "PaymentPlanTerms" WHERE "id" = OLD."id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DuesObligation" WHERE "planTermsId" = OLD."id") THEN
    RAISE EXCEPTION 'dues_config_referenced: a terms version that an obligation references cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION dues_policy_referenced_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "DuesPolicyVersion" WHERE "id" = OLD."id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DuesObligation" WHERE "policyVersionId" = OLD."id") THEN
    RAISE EXCEPTION 'dues_config_referenced: a policy version that an obligation references cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DuesObligation_check_references" BEFORE INSERT ON "DuesObligation" FOR EACH ROW EXECUTE FUNCTION dues_obligation_check_references();
CREATE TRIGGER "PaymentPlanTerms_referenced_guard" BEFORE UPDATE ON "PaymentPlanTerms" FOR EACH ROW EXECUTE FUNCTION dues_terms_referenced_guard();
CREATE TRIGGER "DuesPolicyVersion_referenced_guard" BEFORE UPDATE ON "DuesPolicyVersion" FOR EACH ROW EXECUTE FUNCTION dues_policy_referenced_guard();
