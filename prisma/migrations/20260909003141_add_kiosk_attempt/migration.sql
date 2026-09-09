-- CreateTable
CREATE TABLE "KioskAttempt" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KioskAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KioskAttempt_academyId_ipAddress_createdAt_idx" ON "KioskAttempt"("academyId", "ipAddress", "createdAt");

-- AddForeignKey
ALTER TABLE "KioskAttempt" ADD CONSTRAINT "KioskAttempt_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
