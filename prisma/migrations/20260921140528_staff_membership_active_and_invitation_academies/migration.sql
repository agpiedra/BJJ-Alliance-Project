-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "academyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrganizationMembership" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;
