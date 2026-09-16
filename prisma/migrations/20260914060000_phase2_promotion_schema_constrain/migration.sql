-- DropForeignKey
ALTER TABLE "BeltRequirement" DROP CONSTRAINT "BeltRequirement_organizationId_academyId_fkey";

-- DropForeignKey
ALTER TABLE "BeltRequirement" DROP CONSTRAINT "BeltRequirement_organizationId_fkey";

-- AlterTable
ALTER TABLE "Promotion" DROP COLUMN "fromBelt",
DROP COLUMN "toBelt",
ALTER COLUMN "fromRankId" SET NOT NULL,
ALTER COLUMN "toRankId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "currentBelt",
ALTER COLUMN "currentRankId" SET NOT NULL;

-- DropTable
DROP TABLE "BeltRequirement";

-- DropEnum
DROP TYPE "Belt";
