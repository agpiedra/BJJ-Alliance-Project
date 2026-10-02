-- Enrollment/resume integration plan §7.5/§7.7/§8. Hand-written (same reason as 20260927153000_dues_ledger_schema:
-- Prisma's schema language cannot express CHECK constraints or partial unique indexes). Proved by
-- tests/integration/dues-ledger-schema.test.ts (SIGNUP shape) and the staff-creation idempotency test suite.
--
-- SIGNUP's own shape: dueOn present (the enrollment date itself), no graceDeadline, no lateFeeAmount, no
-- policyVersionId — it never incurs a late fee and is never driven by branch due/grace-day policy. monthsCovered is
-- 1, matching the ASSIGNED MONTHLY PLAN'S OWN terms (planTermsId references that same terms row), not "covers one
-- month" — dues_obligation_check_references (20260927153000) already enforces NEW."monthsCovered" = that terms
-- row's own monthsCovered, unconditionally, for every type; SIGNUP therefore needs monthsCovered = 1 to ever pass
-- that existing, untouched trigger, since package-shaped terms are refused before reaching this obligation write
-- (enrollment-charge.ts checks isPackagePlan first). No DuesCoverage row is ever created for SIGNUP (the writer's
-- own job, not a database constraint) — that, not monthsCovered, is what lets it coexist with a same-month MONTHLY.

ALTER TABLE "DuesObligation" DROP CONSTRAINT "DuesObligation_shape_by_type";

ALTER TABLE "DuesObligation"
  ADD CONSTRAINT "DuesObligation_shape_by_type" CHECK (
    ("type" = 'MONTHLY' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NOT NULL AND "lateFeeAmount" IS NOT NULL
      AND "policyVersionId" IS NOT NULL AND "graceDeadline" >= "dueOn")
    OR ("type" = 'PACKAGE' AND "monthsCovered" >= 2 AND "dueOn" IS NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL)
    OR ("type" = 'SIGNUP' AND "monthsCovered" = 1 AND "dueOn" IS NOT NULL AND "graceDeadline" IS NULL AND "lateFeeAmount" IS NULL
      AND "policyVersionId" IS NULL)
  );

-- At most one SIGNUP obligation per student, ever (studentId alone, like DuesObligation_student_month_monthly_key's
-- own precedent — a student id is never reused across organizations, so no organizationId column is needed here
-- either).
CREATE UNIQUE INDEX "DuesObligation_student_signup_once_key" ON "DuesObligation"("studentId") WHERE "type" = 'SIGNUP';

-- Enrollment/resume integration plan §7.7: staff-creation submission idempotency, active-billing path only. Nullable,
-- left null for every other path (public signup, the inactive path, a future bulk-import). Organization-scoped
-- uniqueness only (@@unique([organizationId, creationRequestId]) in schema.prisma) — NOT a field-level unique, which
-- would wrongly impose global, cross-organization uniqueness (the exact mistake the codeHash column's own history,
-- @@unique([organizationId, codeHash]), already corrected once).
ALTER TABLE "Student" ADD COLUMN "creationRequestId" TEXT;
ALTER TABLE "Student" ADD COLUMN "creationFingerprint" JSONB;

CREATE UNIQUE INDEX "Student_organizationId_creationRequestId_key" ON "Student"("organizationId", "creationRequestId");
