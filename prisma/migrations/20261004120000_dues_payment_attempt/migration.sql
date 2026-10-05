-- CreateTable
CREATE TABLE "DuesPaymentAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "canonicalPayload" JSONB NOT NULL,
    "paymentId" TEXT,
    "receiptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuesPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DuesPaymentAttempt_organizationId_idx" ON "DuesPaymentAttempt"("organizationId");

-- CreateIndex
CREATE INDEX "DuesPaymentAttempt_studentId_idx" ON "DuesPaymentAttempt"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPaymentAttempt_organizationId_submissionId_key" ON "DuesPaymentAttempt"("organizationId", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPaymentAttempt_paymentId_key" ON "DuesPaymentAttempt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPaymentAttempt_receiptId_key" ON "DuesPaymentAttempt"("receiptId");

-- CreateIndex (required by Prisma for the one-to-one payment/receipt relations; redundant with the single-column
-- uniques above at the database level, since each alone already makes this triple unique — the same pattern
-- DuesPayment's own resolvedFromReceiptId precedent uses)
CREATE UNIQUE INDEX "DuesPaymentAttempt_organizationId_paymentId_studentId_key" ON "DuesPaymentAttempt"("organizationId", "paymentId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPaymentAttempt_organizationId_receiptId_studentId_key" ON "DuesPaymentAttempt"("organizationId", "receiptId", "studentId");

-- AddForeignKey
ALTER TABLE "DuesPaymentAttempt" ADD CONSTRAINT "DuesPaymentAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPaymentAttempt" ADD CONSTRAINT "DuesPaymentAttempt_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPaymentAttempt" ADD CONSTRAINT "DuesPaymentAttempt_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (pins organization AND student, so an attempt for one student can never reference another student's
-- payment — rejected by the foreign key itself, not merely application logic; the identical pattern DuesPayment's own
-- resolvedFromReceipt FK already uses)
ALTER TABLE "DuesPaymentAttempt" ADD CONSTRAINT "DuesPaymentAttempt_organizationId_paymentId_studentId_fkey" FOREIGN KEY ("organizationId", "paymentId", "studentId") REFERENCES "DuesPayment"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPaymentAttempt" ADD CONSTRAINT "DuesPaymentAttempt_organizationId_receiptId_studentId_fkey" FOREIGN KEY ("organizationId", "receiptId", "studentId") REFERENCES "AwaitingRateReceipt"("organizationId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints -------------------------------------------------------------------------------------------------
-- Permits both-null (the transient pre-finalization state inside the writer's own open transaction — never committed
-- standalone) and exactly-one-set; forbids both-set.

ALTER TABLE "DuesPaymentAttempt"
  ADD CONSTRAINT "DuesPaymentAttempt_outcome_at_most_one" CHECK (num_nonnulls("paymentId", "receiptId") <= 1);

-- Permanent history, immutable payload ------------------------------------------------------------------------------
-- Reuses the existing generic trigger functions (dues_reject_delete, dues_set_once_marker — both from the dues ledger
-- schema migration), no new PL/pgSQL. dues_set_once_marker's own contract rejects ANY update once a listed marker
-- column is already non-null, AND rejects any update that changes a column OTHER than the listed markers regardless
-- of marker state — this is what protects canonicalPayload (and every other column) unconditionally from the very
-- first UPDATE onward, not merely after an outcome is already set.

CREATE TRIGGER "DuesPaymentAttempt_no_delete" BEFORE DELETE ON "DuesPaymentAttempt" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesPaymentAttempt_outcome_once" BEFORE UPDATE ON "DuesPaymentAttempt" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('outcome', 'paymentId,receiptId');
