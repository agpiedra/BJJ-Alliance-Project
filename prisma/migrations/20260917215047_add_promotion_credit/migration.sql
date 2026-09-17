-- CreateTable
CREATE TABLE "PromotionCredit" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "beltAwardedAtAnchor" TIMESTAMP(3) NOT NULL,
    "classesGranted" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionCredit_studentId_beltAwardedAtAnchor_idx" ON "PromotionCredit"("studentId", "beltAwardedAtAnchor");

-- CreateIndex
CREATE INDEX "PromotionCredit_organizationId_idx" ON "PromotionCredit"("organizationId");

-- AddForeignKey
ALTER TABLE "PromotionCredit" ADD CONSTRAINT "PromotionCredit_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCredit" ADD CONSTRAINT "PromotionCredit_organizationId_academyId_fkey" FOREIGN KEY ("organizationId", "academyId") REFERENCES "Academy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCredit" ADD CONSTRAINT "PromotionCredit_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCredit" ADD CONSTRAINT "PromotionCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
