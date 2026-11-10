-- Stage 9, PR 9-3: advance approval, the owner-initiated atomic switch, opening obligations, first progress row
-- (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md, A1–A8 approved 2026-11-10). One explicit transaction: Prisma's `migrate deploy`
-- does not wrap a file (verified for O4), so a failing statement must leave nothing applied. Inert until an owner approves and
-- switches: nothing here writes a row.
BEGIN;

-- 1. Approval: the opening totals the owner approved, `{ [studentId]: [{ currency, total }] }`, so the switch screen can show old
--    and new totals for every student refreshed after approval (A1). Immutable with the rest of the approval (the existing
--    `dues_activation_set_once` trigger compares every non-marker column). No default: nothing writes this table before 9-3.
ALTER TABLE "DuesActivation" ADD COLUMN "approvedOpeningTotals" JSONB NOT NULL;
ALTER TABLE "DuesActivation" ADD CONSTRAINT "DuesActivation_opening_totals_object" CHECK (jsonb_typeof("approvedOpeningTotals") = 'object');

-- 2. Opening items: the OPENING obligation the switch created from the item. Set once, only on an active item, only to an OPENING
--    obligation of the same organization, student, month, amount and currency; then neither the item nor the link ever changes.
ALTER TABLE "DuesOpeningItem" ADD COLUMN "materializedObligationId" TEXT;
CREATE UNIQUE INDEX "DuesOpeningItem_materializedObligationId_key" ON "DuesOpeningItem"("materializedObligationId");
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_materialized_obligation_fkey"
  FOREIGN KEY ("organizationId", "materializedObligationId", "studentId") REFERENCES "DuesObligation"("organizationId", "id", "studentId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replaces the generic one-marker trigger (8b) on this table: two markers now, withdrawal OR materialization, each set once.
DROP TRIGGER "DuesOpeningItem_marker_once" ON "DuesOpeningItem";
CREATE FUNCTION dues_opening_item_markers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  markers text[] := ARRAY['withdrawnAt', 'withdrawnById', 'withdrawalKind', 'withdrawalReason', 'supersededById', 'materializedObligationId'];
  o "DuesObligation"%ROWTYPE;
BEGIN
  IF (to_jsonb(NEW) - markers) IS DISTINCT FROM (to_jsonb(OLD) - markers) THEN
    RAISE EXCEPTION 'dues_readiness: an opening item''s content never changes (only a marker may be set, once)' USING ERRCODE = '23514';
  END IF;
  IF OLD."withdrawnAt" IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'dues_readiness: a withdrawn opening item never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD."materializedObligationId" IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'dues_readiness: a materialized opening item never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW."materializedObligationId" IS NOT NULL AND OLD."materializedObligationId" IS NULL THEN
    IF NEW."withdrawnAt" IS NOT NULL THEN
      RAISE EXCEPTION 'dues_readiness: only an active opening item is materialized' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO o FROM "DuesObligation" WHERE "id" = NEW."materializedObligationId" AND "organizationId" = NEW."organizationId";
    IF NOT FOUND OR o."type" <> 'OPENING' OR o."studentId" <> NEW."studentId" OR o."coverageYear" <> NEW."coverageYear"
       OR o."coverageMonth" <> NEW."coverageMonth" OR o."amount" <> NEW."amount" OR o."currency" <> NEW."currency" OR o."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'dues_readiness: an opening item is materialized only as an OPENING obligation with its exact content' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DuesOpeningItem_markers" BEFORE UPDATE ON "DuesOpeningItem" FOR EACH ROW EXECUTE FUNCTION dues_opening_item_markers();

-- 3. A8 (b): the owner's acknowledgement names the legacy row it is bound to. Its binding hashes the row's exact stored content,
--    including `recordedAt` (every legacy write sets it), so any later write to the row makes it stale for good.
ALTER TABLE "DuesReadinessConfirmation" ADD COLUMN "legacyPaymentPeriodId" TEXT;
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_legacyPaymentPeriodId_fkey"
  FOREIGN KEY ("legacyPaymentPeriodId") REFERENCES "PaymentPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DuesReadinessConfirmation" DROP CONSTRAINT "DuesReadinessConfirmation_shape_by_kind";
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_shape_by_kind" CHECK (
  ("kind" = 'OPENING_REVIEWED' AND "declaredNoOpeningDebt" IS NOT NULL AND "branchFingerprint" IS NULL AND "legacyPaymentPeriodId" IS NULL)
  OR ("kind" = 'PRICING_ACKNOWLEDGED' AND "branchFingerprint" IS NOT NULL AND "declaredNoOpeningDebt" IS NULL AND "legacyPaymentPeriodId" IS NULL)
  OR ("kind" = 'LEGACY_NO_MONEY' AND "legacyPaymentPeriodId" IS NOT NULL AND "declaredNoOpeningDebt" IS NULL AND "branchFingerprint" IS NULL)
);

-- 4. Progress rows are never deleted: discovery visits only organizations with a row, so deleting one would silently stop billing.
CREATE TRIGGER "DuesGenerationProgress_no_delete" BEFORE DELETE ON "DuesGenerationProgress" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();

-- 5. An effective activation has its start month's progress row (checked at COMMIT: the switch writes both in one transaction).
CREATE FUNCTION dues_activation_has_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."effectiveAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DuesGenerationProgress"
    WHERE "organizationId" = NEW."organizationId" AND "year" = NEW."startYear" AND "month" = NEW."startMonth"
  ) THEN
    RAISE EXCEPTION 'dues_activation: an effective activation must have its start month''s progress row' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "DuesActivation_effective_has_progress" AFTER UPDATE ON "DuesActivation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dues_activation_has_progress();

COMMIT;
