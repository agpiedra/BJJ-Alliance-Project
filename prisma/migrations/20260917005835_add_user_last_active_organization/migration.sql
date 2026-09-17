-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastActiveOrganizationId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_lastActiveOrganizationId_fkey" FOREIGN KEY ("lastActiveOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
