-- O4: prepaid-payment reversal (owner decisions B1–B10, approved 2026-11-09; docs/dues/O4-PREPAYMENT-REVERSAL-PLAN.md).
--
-- Reversing a payment that created prepaid FUTURE months cancels those obligations and releases their coverage, so the
-- monthly job can bill each month normally when it opens (B2). Nothing is deleted; every amount, date and currency stays
-- immutable; only a set-once marker may be written.
--
-- ONE EXPLICIT TRANSACTION. Verified locally on 2026-11-09 against Prisma 7.10: `prisma migrate deploy` does NOT wrap a
-- migration file in a transaction (a statement that fails mid-file leaves the earlier statements applied). This file swaps
-- triggers and unique indexes that protect money; there must never be a committed state with one removed and its replacement
-- missing. With BEGIN ... COMMIT a failure changes nothing (also verified); Prisma then records this migration as failed:
-- recover with `prisma migrate resolve --rolled-back 20261110120000_dues_prepayment_reversal_cancellation`, fix, re-run.
--
-- ROLLBACK: code rollback is UNSAFE once the first cancellation exists, and this schema can be reverted only while no
-- cancelled or released row exists. See docs/DEPLOYMENT_RUNBOOK.md, "O4 prepaid-payment reversal".

BEGIN;

-- 1. Columns. Additive and nullable: catalog-only, no table rewrite. ---------------------------------------------------------
ALTER TABLE "DuesObligation" ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledById" TEXT,
ADD COLUMN "cancelledByReversalOfPaymentId" TEXT;

ALTER TABLE "DuesCoverage" ADD COLUMN "releasedAt" TIMESTAMP(3);

ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite: the cancelling payment must be the SAME student's, in the same organization.
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_organizationId_cancelledByReversalOfPayment_fkey" FOREIGN KEY ("organizationId", "cancelledByReversalOfPaymentId", "studentId") REFERENCES "DuesPayment"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Marker shape: all four together with a non-blank reason; today ONLY a prepaid MONTHLY obligation, ONLY via a payment
--    reversal. (A future O2 opening-item cancellation widens this deliberately, in its own migration.)
ALTER TABLE "DuesObligation" ADD CONSTRAINT "DuesObligation_cancellation_marker_complete" CHECK (
  ("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL AND "cancelledByReversalOfPaymentId" IS NULL)
  OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> ''
      AND "cancelledByReversalOfPaymentId" IS NOT NULL AND "type" = 'MONTHLY' AND "origin" = 'PREPAYMENT')
);

-- 3. Immutability, narrowed by exactly one marker each. ---------------------------------------------------------------------
-- Obligation: same function name and trigger as before (replaced in place, so the trigger is never absent). Every snapshot
-- column stays immutable with the original message; the four marker columns may go from all-null to set, once.
CREATE OR REPLACE FUNCTION dues_obligation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cols text[] := ARRAY['cancelledAt', 'cancelledById', 'cancellationReason', 'cancelledByReversalOfPaymentId'];
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
BEGIN
  IF (new_j - cols) IS DISTINCT FROM (old_j - cols) THEN
    RAISE EXCEPTION 'dues_ledger: obligation rows are immutable (nothing, including the due and grace dates, may change)' USING ERRCODE = '23514';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND new_j IS DISTINCT FROM old_j THEN
    RAISE EXCEPTION 'dues_ledger: only the cancellation marker may be set, once (it is already set)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Coverage: a new function; the old always-reject trigger is swapped for it inside this transaction.
CREATE FUNCTION dues_coverage_release_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'releasedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'releasedAt') THEN
    RAISE EXCEPTION 'dues_ledger: coverage rows are never updated' USING ERRCODE = '23514';
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'dues_ledger: only the release marker may be set, once (it is already set)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER "DuesCoverage_no_update" ON "DuesCoverage";
CREATE TRIGGER "DuesCoverage_release_once" BEFORE UPDATE ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION dues_coverage_release_once();

-- A row is never born cancelled or released.
CREATE FUNCTION dues_marker_absent_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cols text[] := string_to_array(TG_ARGV[1], ',');
  new_j jsonb := to_jsonb(NEW);
  c text;
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF new_j -> c <> 'null'::jsonb THEN
      RAISE EXCEPTION 'dues_ledger: the % marker cannot be set on insert (%)', TG_ARGV[0], TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER "DuesObligation_no_marker_on_insert" BEFORE INSERT ON "DuesObligation" FOR EACH ROW
  EXECUTE FUNCTION dues_marker_absent_on_insert('cancellation', 'cancelledAt,cancelledById,cancellationReason,cancelledByReversalOfPaymentId');
CREATE TRIGGER "DuesCoverage_no_marker_on_insert" BEFORE INSERT ON "DuesCoverage" FOR EACH ROW
  EXECUTE FUNCTION dues_marker_absent_on_insert('release', 'releasedAt');

-- 4. A cancelled obligation is never settled or charged a fee. FOR SHARE on the obligation row conflicts with the cancelling
--    UPDATE, so an insert racing a cancellation waits for it and then sees the committed marker (READ COMMITTED re-reads).
CREATE FUNCTION dues_refuse_cancelled_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cancelled timestamp(3);
BEGIN
  SELECT "cancelledAt" INTO cancelled FROM "DuesObligation" WHERE "id" = NEW."obligationId" FOR SHARE;
  IF cancelled IS NOT NULL THEN
    RAISE EXCEPTION 'dues_ledger: a cancelled obligation cannot be settled or charged a fee (%)', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DuesSettlement_obligation_not_cancelled" BEFORE INSERT ON "DuesSettlement" FOR EACH ROW EXECUTE FUNCTION dues_refuse_cancelled_obligation();
CREATE TRIGGER "DuesLateFee_obligation_not_cancelled" BEFORE INSERT ON "DuesLateFee" FOR EACH ROW EXECUTE FUNCTION dues_refuse_cancelled_obligation();

-- 5. Cancellation preconditions, checked at the cancelling UPDATE (immediate):
--    - no active settlement and no late-fee row (the reversal reverses its settlements first, in the same transaction);
--    - the month has NOT started (B3) in the student's home-branch timezone. now() is the transaction's start, never later
--      than the application's own post-lock instant, so this can only be as strict as the writer, never stricter in a way
--      that contradicts it (except for clock skew between servers; that surfaces as a refusal that rolls back everything).
CREATE FUNCTION dues_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER "DuesObligation_cancellation_guard" AFTER UPDATE ON "DuesObligation" FOR EACH ROW
  WHEN (OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL) EXECUTE FUNCTION dues_cancellation_guard();

-- 6. Cancellation and release stay consistent, checked at COMMIT (deferred: the writer updates the obligation and then its
--    coverage, two rows). A cancelled obligation must:
--    - have released every coverage row it owns;
--    - name a payment that is reversed in this same transaction or earlier;
--    - have had EXACTLY ONE settlement ever, and that settlement belongs to the cancelling payment (rule R1: the payment
--      that created it, by invariant I1 below).
--    A released coverage row must belong to a cancelled obligation.
CREATE FUNCTION dues_cancellation_release_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER "DuesObligation_cancellation_consistent" AFTER UPDATE ON "DuesObligation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL) EXECUTE FUNCTION dues_cancellation_release_consistent();
CREATE CONSTRAINT TRIGGER "DuesCoverage_release_consistent" AFTER UPDATE ON "DuesCoverage" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL) EXECUTE FUNCTION dues_cancellation_release_consistent();

-- 7. Invariant I1: a PREPAYMENT obligation is settled in the transaction that creates it (checked at COMMIT). With settlements
--    never deleted, its first settlement is therefore always the payment that bought it.
CREATE FUNCTION dues_prepayment_settled_at_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DuesSettlement" WHERE "obligationId" = NEW."id" AND "reversedAt" IS NULL) THEN
    RAISE EXCEPTION 'dues_ledger: a PREPAYMENT obligation must be settled in the transaction that creates it' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "DuesObligation_prepayment_settled_at_creation" AFTER INSERT ON "DuesObligation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."origin" = 'PREPAYMENT') EXECUTE FUNCTION dues_prepayment_settled_at_creation();

-- 8. One LIVE monthly obligation and one UNRELEASED coverage row per student-month. Same names, narrowed predicates; dropped
--    and recreated inside this transaction, so no committed state lacks either. Existing rows have no markers, so the new
--    indexes enforce exactly what the old ones did until the first cancellation.
DROP INDEX "DuesObligation_student_month_monthly_key";
CREATE UNIQUE INDEX "DuesObligation_student_month_monthly_key" ON "DuesObligation"("studentId", "coverageYear", "coverageMonth") WHERE "type" = 'MONTHLY' AND "cancelledAt" IS NULL;

DROP INDEX "DuesCoverage_studentId_year_month_key";
CREATE UNIQUE INDEX "DuesCoverage_studentId_year_month_key" ON "DuesCoverage"("studentId", "year", "month") WHERE "releasedAt" IS NULL;

COMMIT;
