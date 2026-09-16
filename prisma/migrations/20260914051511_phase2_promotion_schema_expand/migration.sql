-- CreateEnum
CREATE TYPE "Track" AS ENUM ('ADULT', 'KIDS');

-- CreateEnum
CREATE TYPE "PromotionMode" AS ENUM ('ATTENDANCE', 'TIME', 'HYBRID', 'MANUAL');

-- CreateEnum
CREATE TYPE "PromotionSource" AS ENUM ('MANUAL', 'AUTO', 'CORRECTION');

-- DropForeignKey
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_awardedById_fkey";

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "fromRankId" TEXT,
ADD COLUMN     "source" "PromotionSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "toRankId" TEXT,
ALTER COLUMN "awardedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "currentRankId" TEXT,
ADD COLUMN     "timeAnchorAt" TIMESTAMP(3),
ADD COLUMN     "track" "Track" NOT NULL DEFAULT 'ADULT';

-- CreateTable
CREATE TABLE "BeltRank" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "track" "Track" NOT NULL,
    "code" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "maxStripes" INTEGER NOT NULL,
    "attendancesPerStripe" INTEGER,
    "attendancesForExam" INTEGER,
    "monthsPerStripe" INTEGER,
    "monthsForExam" INTEGER,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "stripeColors" TEXT[],
    "visibleStripeSlots" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BeltRank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "track" "Track" NOT NULL,
    "mode" "PromotionMode" NOT NULL,
    "requiresCoachApproval" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BeltRank_organizationId_idx" ON "BeltRank"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BeltRank_organizationId_id_key" ON "BeltRank"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BeltRank_organizationId_track_code_key" ON "BeltRank"("organizationId", "track", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BeltRank_organizationId_track_order_key" ON "BeltRank"("organizationId", "track", "order");

-- CreateIndex
CREATE INDEX "PromotionConfig_organizationId_idx" ON "PromotionConfig"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionConfig_organizationId_track_key" ON "PromotionConfig"("organizationId", "track");

-- CreateIndex
CREATE INDEX "Promotion_fromRankId_idx" ON "Promotion"("fromRankId");

-- CreateIndex
CREATE INDEX "Promotion_toRankId_idx" ON "Promotion"("toRankId");

-- CreateIndex
CREATE INDEX "Student_currentRankId_idx" ON "Student"("currentRankId");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_organizationId_currentRankId_fkey" FOREIGN KEY ("organizationId", "currentRankId") REFERENCES "BeltRank"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organizationId_fromRankId_fkey" FOREIGN KEY ("organizationId", "fromRankId") REFERENCES "BeltRank"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organizationId_toRankId_fkey" FOREIGN KEY ("organizationId", "toRankId") REFERENCES "BeltRank"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_awardedById_fkey" FOREIGN KEY ("awardedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeltRank" ADD CONSTRAINT "BeltRank_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionConfig" ADD CONSTRAINT "PromotionConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
