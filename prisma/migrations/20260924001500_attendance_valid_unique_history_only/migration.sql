-- A voided attendance entry must not block a valid replacement, so the "one entry per class occurrence" rule
-- (student, class, day) applies to VALID entries only. It becomes a PARTIAL unique index; Prisma's schema language
-- cannot express one, so it lives here (schema.prisma documents it). The new index is strictly weaker than the old
-- one, so it can never fail on existing data. It is created BEFORE the old one is dropped, so the rule is never
-- absent. Class-less rows (classSessionId NULL) were never constrained (NULLs are distinct): unchanged.
CREATE UNIQUE INDEX "AttendanceRecord_student_class_date_valid_key"
  ON "AttendanceRecord"("studentId", "classSessionId", "date")
  WHERE "voidedAt" IS NULL;

DROP INDEX "AttendanceRecord_studentId_classSessionId_date_key";

-- Coach-recorded day of a promotion (or of the tracking start): real attendance, never a progress contribution.
ALTER TABLE "AttendanceRecord" ADD COLUMN "historyOnly" BOOLEAN NOT NULL DEFAULT false;
