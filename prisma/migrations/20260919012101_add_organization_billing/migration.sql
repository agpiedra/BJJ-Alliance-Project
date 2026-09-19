-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingNote" TEXT,
ADD COLUMN     "graceDays" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "OrganizationInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "graceDaysApplied" INTEGER NOT NULL DEFAULT 5,
    "graceExtensionDays" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "paidNote" TEXT,
    "recordedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "reviewAcknowledgedAt" TIMESTAMP(3),
    "reviewAcknowledgedById" TEXT,
    "reviewNote" TEXT,
    "reviewAcknowledgedForFlaggedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationInvoice_organizationId_idx" ON "OrganizationInvoice"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "OrganizationInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "OrganizationInvoice_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "OrganizationInvoice_reviewAcknowledgedById_fkey" FOREIGN KEY ("reviewAcknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
