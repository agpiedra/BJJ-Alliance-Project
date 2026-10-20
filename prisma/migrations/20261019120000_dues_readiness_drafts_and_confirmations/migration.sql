-- CreateEnum
CREATE TYPE "DuesOpeningItemWithdrawalKind" AS ENUM ('EDITED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DuesReadinessConfirmationKind" AS ENUM ('OPENING_REVIEWED', 'PRICING_ACKNOWLEDGED');

-- CreateTable
CREATE TABLE "DuesOpeningItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "coverageYear" INTEGER NOT NULL,
    "coverageMonth" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "note" TEXT NOT NULL,
    "legacyPaymentPeriodId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    "withdrawalKind" "DuesOpeningItemWithdrawalKind",
    "withdrawalReason" TEXT,
    "supersededById" TEXT,

    CONSTRAINT "DuesOpeningItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuesReadinessConfirmation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "candidateYear" INTEGER NOT NULL,
    "candidateMonth" INTEGER NOT NULL,
    "kind" "DuesReadinessConfirmationKind" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fingerprintFormat" TEXT NOT NULL,
    "binding" TEXT NOT NULL,
    "studentFingerprint" TEXT NOT NULL,
    "branchFingerprint" TEXT,
    "declaredNoOpeningDebt" BOOLEAN,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuesReadinessConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DuesOpeningItem_supersededById_key" ON "DuesOpeningItem"("supersededById");

-- CreateIndex
CREATE INDEX "DuesOpeningItem_organizationId_idx" ON "DuesOpeningItem"("organizationId");

-- CreateIndex
CREATE INDEX "DuesOpeningItem_organizationId_studentId_idx" ON "DuesOpeningItem"("organizationId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesOpeningItem_organizationId_id_key" ON "DuesOpeningItem"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DuesOpeningItem_organizationId_studentId_id_key" ON "DuesOpeningItem"("organizationId", "studentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DuesOpeningItem_organizationId_studentId_supersededById_key" ON "DuesOpeningItem"("organizationId", "studentId", "supersededById");

-- CreateIndex
CREATE INDEX "DuesReadinessConfirmation_organizationId_idx" ON "DuesReadinessConfirmation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesReadinessConfirmation_organizationId_studentId_candidat_key" ON "DuesReadinessConfirmation"("organizationId", "studentId", "candidateYear", "candidateMonth", "kind", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPeriod_organizationId_studentId_year_month_id_key" ON "PaymentPeriod"("organizationId", "studentId", "year", "month", "id");

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_organizationId_studentId_coverageYear_cove_fkey" FOREIGN KEY ("organizationId", "studentId", "coverageYear", "coverageMonth", "legacyPaymentPeriodId") REFERENCES "PaymentPeriod"("organizationId", "studentId", "year", "month", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_organizationId_studentId_supersededById_fkey" FOREIGN KEY ("organizationId", "studentId", "supersededById") REFERENCES "DuesOpeningItem"("organizationId", "studentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
-- ^ Hand-edited: Prisma generates this FK without DEFERRABLE (its schema language cannot express it). Deferred because the edit
--   protocol sets the old row's marker (naming the successor id) BEFORE inserting the successor; checked at COMMIT.

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesReadinessConfirmation" ADD CONSTRAINT "DuesReadinessConfirmation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written part (stage 8b, docs/dues/STAGE-8B-IMPLEMENTATION-PLAN.md §2). Prisma's schema language cannot express CHECK
-- constraints, partial unique indexes or triggers, so this migration is their source of truth; each is proved by
-- tests/integration/dues-readiness-schema.test.ts. The only object added on an existing table is the PaymentPeriod unique
-- index above (it includes "id", so no existing row can conflict). No data: no backfill, seed or default amount.
-- ---------------------------------------------------------------------------------------------------------------------------------

-- CHECK constraints ------------------------------------------------------------------------------------------------------------------
-- Year 2000 to 2100 is the same typo guard the configuration and ledger tables use, not a business rule.
ALTER TABLE "DuesOpeningItem"
  ADD CONSTRAINT "DuesOpeningItem_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "DuesOpeningItem_month_valid" CHECK ("coverageMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesOpeningItem_year_sane" CHECK ("coverageYear" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "DuesOpeningItem_note_present" CHECK (char_length(btrim("note")) BETWEEN 1 AND 500),
  ADD CONSTRAINT "DuesOpeningItem_withdrawal_reason_length" CHECK ("withdrawalReason" IS NULL OR char_length(btrim("withdrawalReason")) BETWEEN 1 AND 500),
  -- The marker is all-null (active) or complete: EDITED names its successor; WITHDRAWN has a reason and no successor.
  ADD CONSTRAINT "DuesOpeningItem_withdrawal_marker_complete" CHECK (
    ("withdrawnAt" IS NULL AND "withdrawnById" IS NULL AND "withdrawalKind" IS NULL AND "withdrawalReason" IS NULL AND "supersededById" IS NULL)
    OR ("withdrawnAt" IS NOT NULL AND "withdrawnById" IS NOT NULL AND (
         ("withdrawalKind" = 'EDITED' AND "supersededById" IS NOT NULL)
         OR ("withdrawalKind" = 'WITHDRAWN' AND "supersededById" IS NULL AND "withdrawalReason" IS NOT NULL)
       ))
  ),
  ADD CONSTRAINT "DuesOpeningItem_not_self_superseding" CHECK ("supersededById" IS NULL OR "supersededById" <> "id");

ALTER TABLE "DuesReadinessConfirmation"
  ADD CONSTRAINT "DuesReadinessConfirmation_sequence_positive" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "DuesReadinessConfirmation_month_valid" CHECK ("candidateMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesReadinessConfirmation_year_sane" CHECK ("candidateYear" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "DuesReadinessConfirmation_hashes_hex" CHECK (
    "binding" ~ '^[0-9a-f]{64}$' AND "studentFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("branchFingerprint" IS NULL OR "branchFingerprint" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "DuesReadinessConfirmation_format_present" CHECK (char_length("fingerprintFormat") BETWEEN 1 AND 16),
  ADD CONSTRAINT "DuesReadinessConfirmation_shape_by_kind" CHECK (
    ("kind" = 'OPENING_REVIEWED' AND "declaredNoOpeningDebt" IS NOT NULL AND "branchFingerprint" IS NULL)
    OR ("kind" = 'PRICING_ACKNOWLEDGED' AND "branchFingerprint" IS NOT NULL AND "declaredNoOpeningDebt" IS NULL)
  );

-- Partial unique index: at most one ACTIVE draft per student and month. Immediate (an index cannot be deferred), which is why an
-- edit sets the old row's marker BEFORE inserting its successor.
CREATE UNIQUE INDEX "DuesOpeningItem_one_active_per_month_key" ON "DuesOpeningItem"("organizationId", "studentId", "coverageYear", "coverageMonth") WHERE "withdrawnAt" IS NULL;

-- Triggers -----------------------------------------------------------------------------------------------------------------------------
-- dues_reject_delete() and dues_set_once_marker() are the ledger's own functions (20260927153000_dues_ledger_schema), reused unchanged.
CREATE FUNCTION dues_readiness_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dues_readiness: confirmation rows are never updated (record a new one)' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "DuesOpeningItem_no_delete" BEFORE DELETE ON "DuesOpeningItem" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesOpeningItem_marker_once" BEFORE UPDATE ON "DuesOpeningItem" FOR EACH ROW
  EXECUTE FUNCTION dues_set_once_marker('withdrawal', 'withdrawnAt,withdrawnById,withdrawalKind,withdrawalReason,supersededById');
CREATE TRIGGER "DuesReadinessConfirmation_no_delete" BEFORE DELETE ON "DuesReadinessConfirmation" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "DuesReadinessConfirmation_no_update" BEFORE UPDATE ON "DuesReadinessConfirmation" FOR EACH ROW EXECUTE FUNCTION dues_readiness_reject_update();
