-- CreateEnum
CREATE TYPE "AttendanceMatchSource" AS ENUM ('AUTO', 'STUDENT_PICKED', 'STAFF_CORRECTED', 'UNMATCHED');

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "correctedById" TEXT,
ADD COLUMN     "matchSource" "AttendanceMatchSource" NOT NULL DEFAULT 'AUTO';

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_correctedById_fkey" FOREIGN KEY ("correctedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
