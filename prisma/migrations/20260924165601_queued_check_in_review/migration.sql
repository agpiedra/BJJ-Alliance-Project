-- CreateEnum
CREATE TYPE "QueuedCheckInStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "QueuedCheckInReason" AS ENUM ('TIMESTAMP_NOT_VERIFIED', 'NO_CLASS_OPEN', 'SEVERAL_CLASSES_OPEN', 'SELECTION_NOT_OPEN');

-- CreateTable
CREATE TABLE "QueuedCheckIn" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "claimedAtRaw" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedAtVerified" BOOLEAN NOT NULL,
    "claimedClassSessionId" TEXT,
    "reason" "QueuedCheckInReason" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "QueuedCheckInStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAttendanceId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "dismissReason" TEXT,

    CONSTRAINT "QueuedCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueuedCheckIn_organizationId_academyId_status_idx" ON "QueuedCheckIn"("organizationId", "academyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QueuedCheckIn_organizationId_studentId_eventKey_key" ON "QueuedCheckIn"("organizationId", "studentId", "eventKey");

-- AddForeignKey
ALTER TABLE "QueuedCheckIn" ADD CONSTRAINT "QueuedCheckIn_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueuedCheckIn" ADD CONSTRAINT "QueuedCheckIn_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueuedCheckIn" ADD CONSTRAINT "QueuedCheckIn_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueuedCheckIn" ADD CONSTRAINT "QueuedCheckIn_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
