-- CreateTable
CREATE TABLE "DuesGenerationProgress" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "cursorStudentId" TEXT,
    "passStartedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastVisitedAt" TIMESTAMP(3) NOT NULL,
    "inFlightStudentId" TEXT,
    "inFlightAttempts" INTEGER NOT NULL DEFAULT 0,
    "passIneligible" INTEGER NOT NULL DEFAULT 0,
    "passCovered" INTEGER NOT NULL DEFAULT 0,
    "passUnpriced" INTEGER NOT NULL DEFAULT 0,
    "passPending" INTEGER NOT NULL DEFAULT 0,
    "lastPassCompletedAt" TIMESTAMP(3),
    "lastPassIneligible" INTEGER,
    "lastPassCovered" INTEGER,
    "lastPassUnpriced" INTEGER,
    "lastPassPending" INTEGER,
    "lastPassClean" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuesGenerationProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DuesGenerationProgress_lastVisitedAt_id_idx" ON "DuesGenerationProgress"("lastVisitedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DuesGenerationProgress_organizationId_year_month_key" ON "DuesGenerationProgress"("organizationId", "year", "month");

-- AddForeignKey
ALTER TABLE "DuesGenerationProgress" ADD CONSTRAINT "DuesGenerationProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written part (docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md revision 4, §5). Prisma's schema language cannot express
-- CHECK constraints, so this migration is their source of truth; each is proved by
-- tests/integration/monthly-generation-progress-schema.test.ts. A new table only: no existing table is touched, and no row is
-- inserted (stage 9 inserts an organization's first row in its activation transaction; until then the table stays empty).
-- ---------------------------------------------------------------------------------------------------------------------------------
-- Year 2000 to 2100 is the same typo guard the configuration and ledger tables use, not a business rule.
ALTER TABLE "DuesGenerationProgress"
  ADD CONSTRAINT "DuesGenerationProgress_month_valid" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesGenerationProgress_year_sane" CHECK ("year" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "DuesGenerationProgress_counts_nonnegative" CHECK (
    "passIneligible" >= 0 AND "passCovered" >= 0 AND "passUnpriced" >= 0 AND "passPending" >= 0
  ),
  -- A pass with no committed student has no start time and no counts; a pass with one has both.
  ADD CONSTRAINT "DuesGenerationProgress_pass_state_complete" CHECK (
    ("cursorStudentId" IS NULL AND "passStartedAt" IS NULL
      AND "passIneligible" = 0 AND "passCovered" = 0 AND "passUnpriced" = 0 AND "passPending" = 0)
    OR ("cursorStudentId" IS NOT NULL AND "passStartedAt" IS NOT NULL)
  ),
  -- A lease is a token and an expiry together.
  ADD CONSTRAINT "DuesGenerationProgress_lease_complete" CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL)),
  -- The crash marker names a student and counts at least one attempt, or is fully clear.
  ADD CONSTRAINT "DuesGenerationProgress_marker_complete" CHECK (
    ("inFlightStudentId" IS NULL AND "inFlightAttempts" = 0) OR ("inFlightStudentId" IS NOT NULL AND "inFlightAttempts" >= 1)
  ),
  -- The last finished pass is recorded whole, or not at all, and "clean" is exactly zero unpriced and zero pending.
  ADD CONSTRAINT "DuesGenerationProgress_last_pass_complete" CHECK (
    ("lastPassCompletedAt" IS NULL AND "lastPassIneligible" IS NULL AND "lastPassCovered" IS NULL AND "lastPassUnpriced" IS NULL
      AND "lastPassPending" IS NULL AND "lastPassClean" IS NULL)
    -- Every column IS NOT NULL explicitly: a CHECK that evaluates to NULL passes, and NULL >= 0 is NULL.
    OR ("lastPassCompletedAt" IS NOT NULL AND "lastPassIneligible" IS NOT NULL AND "lastPassCovered" IS NOT NULL
      AND "lastPassUnpriced" IS NOT NULL AND "lastPassPending" IS NOT NULL AND "lastPassClean" IS NOT NULL
      AND "lastPassIneligible" >= 0 AND "lastPassCovered" >= 0 AND "lastPassUnpriced" >= 0 AND "lastPassPending" >= 0
      AND "lastPassClean" = ("lastPassUnpriced" = 0 AND "lastPassPending" = 0))
  );
