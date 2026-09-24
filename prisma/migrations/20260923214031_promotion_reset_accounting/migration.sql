-- CreateEnum
CREATE TYPE "StripeAccounting" AS ENUM ('CUMULATIVE', 'PER_INTERVAL');

-- CreateEnum
CREATE TYPE "ProgressBaselineKind" AS ENUM ('SYSTEM_BASELINE', 'AWARD');

-- AlterTable
ALTER TABLE "BeltRank" ADD COLUMN     "progressionMode" "PromotionMode",
ADD COLUMN     "stripeIntervalMonths" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "PromotionConfig" ADD COLUMN     "stripeAccounting" "StripeAccounting" NOT NULL DEFAULT 'CUMULATIVE';

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "progressBaselineAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "progressBaselineKind" "ProgressBaselineKind" NOT NULL DEFAULT 'SYSTEM_BASELINE';

-- Promotions are manual only (academy decision): no organization may have
-- automatic promotion enabled. Any row that still says otherwise is set to the
-- only permitted value first (the scheduled awarding path is removed in the same
-- release, so the flag has no remaining effect), then the constraint makes the
-- rule hold for every writer, not just this release's code. Historical
-- Promotion rows with source AUTO are untouched.
UPDATE "PromotionConfig" SET "requiresCoachApproval" = true WHERE "requiresCoachApproval" = false;

ALTER TABLE "PromotionConfig"
  ADD CONSTRAINT "PromotionConfig_manual_promotions_only" CHECK ("requiresCoachApproval" = true);
