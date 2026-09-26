-- CreateTable
CREATE TABLE "DuesPolicyVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "effectiveYear" INTEGER NOT NULL,
    "effectiveMonth" INTEGER NOT NULL,
    "dueDay" INTEGER NOT NULL,
    "graceDay" INTEGER NOT NULL,
    "lateFeeAmount" DECIMAL(10,2) NOT NULL,
    "lateFeeCurrency" "Currency" NOT NULL,
    "maxPrepaidMonths" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuesPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlanTerms" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "effectiveYear" INTEGER NOT NULL,
    "effectiveMonth" INTEGER NOT NULL,
    "priceAmount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "monthsCovered" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPlanTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentPlanAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "planId" TEXT,
    "effectiveYear" INTEGER NOT NULL,
    "effectiveMonth" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentPlanAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DuesPolicyVersion_organizationId_idx" ON "DuesPolicyVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DuesPolicyVersion_academyId_effectiveYear_effectiveMonth_key" ON "DuesPolicyVersion"("academyId", "effectiveYear", "effectiveMonth");

-- CreateIndex
CREATE INDEX "PaymentPlanTerms_organizationId_idx" ON "PaymentPlanTerms"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlanTerms_planId_effectiveYear_effectiveMonth_key" ON "PaymentPlanTerms"("planId", "effectiveYear", "effectiveMonth");

-- CreateIndex
CREATE INDEX "StudentPlanAssignment_organizationId_idx" ON "StudentPlanAssignment"("organizationId");

-- CreateIndex
CREATE INDEX "StudentPlanAssignment_planId_idx" ON "StudentPlanAssignment"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentPlanAssignment_studentId_effectiveYear_effectiveMont_key" ON "StudentPlanAssignment"("studentId", "effectiveYear", "effectiveMonth");

-- AddForeignKey
ALTER TABLE "DuesPolicyVersion" ADD CONSTRAINT "DuesPolicyVersion_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPolicyVersion" ADD CONSTRAINT "DuesPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuesPolicyVersion" ADD CONSTRAINT "DuesPolicyVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanTerms" ADD CONSTRAINT "PaymentPlanTerms_organizationId_planId_fkey" FOREIGN KEY ("organizationId", "planId") REFERENCES "PaymentPlan"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanTerms" ADD CONSTRAINT "PaymentPlanTerms_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanTerms" ADD CONSTRAINT "PaymentPlanTerms_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPlanAssignment" ADD CONSTRAINT "StudentPlanAssignment_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPlanAssignment" ADD CONSTRAINT "StudentPlanAssignment_organizationId_planId_fkey" FOREIGN KEY ("organizationId", "planId") REFERENCES "PaymentPlan"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPlanAssignment" ADD CONSTRAINT "StudentPlanAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPlanAssignment" ADD CONSTRAINT "StudentPlanAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints. Prisma's schema language cannot express them, so this migration is their source of truth (documented in
-- schema.prisma above DuesPolicyVersion). Year 2000 to 2100 is a typo guard (an effective year of "26"), not a business rule.
-- Deliberately NOT here: any trigger. The tables are append-only by convention only; updates and deletes are not prevented.

ALTER TABLE "DuesPolicyVersion"
  ADD CONSTRAINT "DuesPolicyVersion_effective_month_valid" CHECK ("effectiveMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "DuesPolicyVersion_effective_year_sane" CHECK ("effectiveYear" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "DuesPolicyVersion_due_day_valid" CHECK ("dueDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "DuesPolicyVersion_grace_day_valid" CHECK ("graceDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "DuesPolicyVersion_late_fee_non_negative" CHECK ("lateFeeAmount" >= 0),
  ADD CONSTRAINT "DuesPolicyVersion_max_prepaid_months_positive" CHECK ("maxPrepaidMonths" IS NULL OR "maxPrepaidMonths" >= 1);

ALTER TABLE "PaymentPlanTerms"
  ADD CONSTRAINT "PaymentPlanTerms_effective_month_valid" CHECK ("effectiveMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "PaymentPlanTerms_effective_year_sane" CHECK ("effectiveYear" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "PaymentPlanTerms_price_positive" CHECK ("priceAmount" > 0),
  ADD CONSTRAINT "PaymentPlanTerms_months_covered_positive" CHECK ("monthsCovered" >= 1);

ALTER TABLE "StudentPlanAssignment"
  ADD CONSTRAINT "StudentPlanAssignment_effective_month_valid" CHECK ("effectiveMonth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "StudentPlanAssignment_effective_year_sane" CHECK ("effectiveYear" BETWEEN 2000 AND 2100);
