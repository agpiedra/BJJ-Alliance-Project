-- STAGE 9 PR 9-3 SCHEMA ROLLBACK for migration 20261113120100_dues_activation_switch.
--
-- NOT A ROUTINE STEP. Run only with explicit owner approval, by hand (psql), in this order:
--   1. deploy an application build that predates PR 9-3;
--   2. then run this script.
-- If 9-2, 9-1 or O4 must also be rolled back, run THIS script first, then the 9-2 script, then 9-1, then O4.
--
-- REFUSES once any activation record exists (approved, withdrawn or effective) or any "no money received" acknowledgement exists:
-- those are the owner's decisions and are never deleted. An effective activation is forward-only (A5): after the first switch,
-- recovery is a forward fix, never a rollback (the previous code would stop billing an activated organization). The checks run
-- under locks that stop new rows being inserted between the check and the restore.
--
-- The enum value 'LEGACY_NO_MONEY' (migration 20261113120000) STAYS: PostgreSQL cannot drop an enum value without rebuilding the
-- type, and an unused value is inert. That migration's record stays too; only 20261113120100's record is removed (it re-applies
-- on the next deploy). So the rolled-back schema is NOT the pre-9-3 schema: it differs by exactly that one retained enum value.

BEGIN;

LOCK TABLE "DuesActivation", "DuesReadinessConfirmation", "DuesOpeningItem", "DuesGenerationProgress" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DuesActivation") THEN
    RAISE EXCEPTION 'Stage 9 PR 9-3 rollback refused: activation records exist. They are never deleted; use a forward fix.';
  END IF;
  IF EXISTS (SELECT 1 FROM "DuesReadinessConfirmation" WHERE "kind" = 'LEGACY_NO_MONEY') THEN
    RAISE EXCEPTION 'Stage 9 PR 9-3 rollback refused: "no money received" acknowledgements exist. They are never deleted; use a forward fix.';
  END IF;
END $$;

-- 5 and 4: the activation/progress triggers added by 9-3.
DROP TRIGGER "DuesActivation_effective_has_progress" ON "DuesActivation";
DROP FUNCTION dues_activation_has_progress();
DROP TRIGGER "DuesGenerationProgress_no_delete" ON "DuesGenerationProgress";

-- 3: confirmations back to the 8b shape (verbatim from 20261019120000).
ALTER TABLE "DuesReadinessConfirmation" DROP CONSTRAINT "DuesReadinessConfirmation_shape_by_kind";
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_shape_by_kind" CHECK (
    ("kind" = 'OPENING_REVIEWED' AND "declaredNoOpeningDebt" IS NOT NULL AND "branchFingerprint" IS NULL)
    OR ("kind" = 'PRICING_ACKNOWLEDGED' AND "branchFingerprint" IS NOT NULL AND "declaredNoOpeningDebt" IS NULL)
  );
ALTER TABLE "DuesReadinessConfirmation" DROP CONSTRAINT "DuesReadinessConfirmation_legacyPaymentPeriodId_fkey";
ALTER TABLE "DuesReadinessConfirmation" DROP COLUMN "legacyPaymentPeriodId";

-- 2: opening items back to the 8b single-marker trigger (verbatim from 20261019120000). With no activation record, no item was
-- ever materialized (only the switch writes the link), so the column is empty.
DROP TRIGGER "DuesOpeningItem_markers" ON "DuesOpeningItem";
DROP FUNCTION dues_opening_item_markers();
CREATE TRIGGER "DuesOpeningItem_marker_once" BEFORE UPDATE ON "DuesOpeningItem" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('withdrawal', 'withdrawnAt,withdrawnById,withdrawalKind,withdrawalReason,supersededById');
ALTER TABLE "DuesOpeningItem" DROP CONSTRAINT "DuesOpeningItem_materialized_obligation_fkey";
DROP INDEX "DuesOpeningItem_materializedObligationId_key";
ALTER TABLE "DuesOpeningItem" DROP COLUMN "materializedObligationId";

-- 1: the approval's opening totals.
ALTER TABLE "DuesActivation" DROP CONSTRAINT "DuesActivation_opening_totals_object";
ALTER TABLE "DuesActivation" DROP COLUMN "approvedOpeningTotals";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113120100_dues_activation_switch';

COMMIT;
