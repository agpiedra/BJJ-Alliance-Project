-- CreateEnum
CREATE TYPE "AwaitingRateReceiptKind" AS ENUM ('ORDINARY', 'PREPAYMENT', 'PACKAGE');

-- CreateEnum
CREATE TYPE "AwaitingRateReceiptStatus" AS ENUM ('PENDING', 'RESOLVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AwaitingRateReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "kind" "AwaitingRateReceiptKind" NOT NULL,
    "status" "AwaitingRateReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "receivedOn" DATE NOT NULL,
    "tenderCurrency" "Currency" NOT NULL,
    "tenderAmount" DECIMAL(10,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "capturedById" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,

    CONSTRAINT "AwaitingRateReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AwaitingRateReceipt_organizationId_idx" ON "AwaitingRateReceipt"("organizationId");

-- CreateIndex
CREATE INDEX "AwaitingRateReceipt_studentId_idx" ON "AwaitingRateReceipt"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AwaitingRateReceipt_organizationId_id_studentId_key" ON "AwaitingRateReceipt"("organizationId", "id", "studentId");

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwaitingRateReceipt" ADD CONSTRAINT "AwaitingRateReceipt_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (DuesPayment)
ALTER TABLE "DuesPayment" ADD COLUMN "resolvedFromReceiptId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DuesPayment_resolvedFromReceiptId_key" ON "DuesPayment"("resolvedFromReceiptId");

-- CreateIndex (required by Prisma for the one-to-one relation; redundant with the single-column unique above at the
-- database level, since that alone already makes this triple unique)
CREATE UNIQUE INDEX "DuesPayment_organizationId_resolvedFromReceiptId_studentId_key" ON "DuesPayment"("organizationId", "resolvedFromReceiptId", "studentId");

-- AddForeignKey (currency-conversion brief PR 3, plan §5: pins organization AND student, so a payment for one student can
-- never reference another student's receipt — rejected by the foreign key itself, not merely application logic)
ALTER TABLE "DuesPayment" ADD CONSTRAINT "DuesPayment_organizationId_resolvedFromReceiptId_studentId_fkey" FOREIGN KEY ("organizationId", "resolvedFromReceiptId", "studentId") REFERENCES "AwaitingRateReceipt"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints -----------------------------------------------------------------------------------------------------

ALTER TABLE "AwaitingRateReceipt"
  ADD CONSTRAINT "AwaitingRateReceipt_tender_positive" CHECK ("tenderAmount" > 0),
  ADD CONSTRAINT "AwaitingRateReceipt_received_on_sane" CHECK (EXTRACT(YEAR FROM "receivedOn") BETWEEN 2000 AND 2100),
  -- The precise three-state shape (plan §6.1): PENDING has neither marker group set; RESOLVED has only the resolution
  -- markers complete; CANCELLED has only the cancellation markers complete with a non-blank reason. Both terminal states
  -- are irreversible (enforced by the trigger below, not this CHECK — a CHECK alone cannot compare OLD to NEW).
  ADD CONSTRAINT "AwaitingRateReceipt_status_markers_consistent" CHECK (
    ("status" = 'PENDING' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'CANCELLED' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> '')
  );

-- Permanent history, irreversible terminal states ------------------------------------------------------------------------
-- Reuses the existing generic delete-rejection function (dues_reject_delete, from the dues ledger schema migration) — the
-- same "history is permanent" guarantee every other dues table already has. The update trigger is table-specific (not the
-- existing generic dues_set_once_marker) because this table has a non-marker column, `status`, that must also change
-- exactly once, in step with its matching marker group — dues_set_once_marker's own contract assumes no sibling column
-- changes alongside the marker group it protects.

CREATE FUNCTION dues_awaiting_rate_receipt_marker_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'dues_ledger: an awaiting-rate receipt''s resolution or cancellation is irreversible (status already %)', OLD."status" USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'resolvedAt' - 'resolvedById' - 'cancelledAt' - 'cancelledById' - 'cancellationReason')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'resolvedAt' - 'resolvedById' - 'cancelledAt' - 'cancelledById' - 'cancellationReason') THEN
    RAISE EXCEPTION 'dues_ledger: only an awaiting-rate receipt''s status and its matching marker group may be set, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "AwaitingRateReceipt_no_delete" BEFORE DELETE ON "AwaitingRateReceipt" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "AwaitingRateReceipt_marker_once" BEFORE UPDATE ON "AwaitingRateReceipt" FOR EACH ROW EXECUTE FUNCTION dues_awaiting_rate_receipt_marker_once();
