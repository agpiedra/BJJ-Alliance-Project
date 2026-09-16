-- DropForeignKey
ALTER TABLE "Academy" DROP CONSTRAINT "Academy_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_academyId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_classSessionId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_studentId_fkey";

-- DropForeignKey
ALTER TABLE "BeltRequirement" DROP CONSTRAINT "BeltRequirement_academyId_fkey";

-- DropForeignKey
ALTER TABLE "BeltRequirement" DROP CONSTRAINT "BeltRequirement_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ClassSession" DROP CONSTRAINT "ClassSession_academyId_fkey";

-- DropForeignKey
ALTER TABLE "ClassSession" DROP CONSTRAINT "ClassSession_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "KioskAttempt" DROP CONSTRAINT "KioskAttempt_academyId_fkey";

-- DropForeignKey
ALTER TABLE "KioskAttempt" DROP CONSTRAINT "KioskAttempt_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPeriod" DROP CONSTRAINT "PaymentPeriod_academyId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPeriod" DROP CONSTRAINT "PaymentPeriod_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPeriod" DROP CONSTRAINT "PaymentPeriod_planId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPeriod" DROP CONSTRAINT "PaymentPeriod_studentId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPlan" DROP CONSTRAINT "PaymentPlan_academyId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentPlan" DROP CONSTRAINT "PaymentPlan_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_academyId_fkey";

-- DropForeignKey
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_studentId_fkey";

-- DropForeignKey
ALTER TABLE "StaffAssignment" DROP CONSTRAINT "StaffAssignment_academyId_fkey";

-- DropForeignKey
ALTER TABLE "StaffAssignment" DROP CONSTRAINT "StaffAssignment_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_homeAcademyId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_organizationId_fkey";

-- DropIndex
DROP INDEX "BeltRequirement_academyId_belt_key";

-- DropIndex
DROP INDEX "Student_codeHash_key";

-- AlterTable
ALTER TABLE "Academy" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AttendanceRecord" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BeltRequirement" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ClassSession" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "KioskAttempt" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PaymentPeriod" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PaymentPlan" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Promotion" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StaffAssignment" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Student" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Academy_organizationId_id_key" ON "Academy"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BeltRequirement_organizationId_academyId_belt_key" ON "BeltRequirement"("organizationId", "academyId", "belt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_organizationId_id_key" ON "ClassSession"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_organizationId_id_key" ON "PaymentPlan"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Student_organizationId_codeHash_key" ON "Student"("organizationId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Student_organizationId_id_key" ON "Student"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Academy" ADD CONSTRAINT "Academy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_organizationId_homeAcademyId_fkey" FOREIGN KEY ("organizationId", "homeAcademyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organizationId_classSessionId_fkey" FOREIGN KEY ("organizationId", "classSessionId") REFERENCES "ClassSession"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeltRequirement" ADD CONSTRAINT "BeltRequirement_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeltRequirement" ADD CONSTRAINT "BeltRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPeriod" ADD CONSTRAINT "PaymentPeriod_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPeriod" ADD CONSTRAINT "PaymentPeriod_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPeriod" ADD CONSTRAINT "PaymentPeriod_organizationId_planId_fkey" FOREIGN KEY ("organizationId", "planId") REFERENCES "PaymentPlan"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPeriod" ADD CONSTRAINT "PaymentPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KioskAttempt" ADD CONSTRAINT "KioskAttempt_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KioskAttempt" ADD CONSTRAINT "KioskAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

