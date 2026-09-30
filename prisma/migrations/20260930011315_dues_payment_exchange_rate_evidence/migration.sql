-- AlterTable
ALTER TABLE "DuesPayment" ADD COLUMN     "appliedRateId" TEXT,
ADD COLUMN     "appliedRateQuoteDate" DATE,
ADD COLUMN     "appliedRateRevision" INTEGER,
ADD COLUMN     "appliedRateValue" DECIMAL(12,6),
ADD COLUMN     "appliedRoundingRule" TEXT;

-- AddForeignKey
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_organizationId_appliedRateId_fkey" FOREIGN KEY ("organizationId", "appliedRateId") REFERENCES "ExchangeRateQuote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
