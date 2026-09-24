-- One class-less check-in per student per Costa Rica day (valid rows only).
--
-- The ordinary per-occurrence rule, "AttendanceRecord_student_class_date_valid_key" on
-- (studentId, classSessionId, date) WHERE voidedAt IS NULL, cannot see a check-in that is not attached to a class:
-- Postgres treats NULLs as distinct, so any number of class-less rows for the same day slipped past it. The
-- application only pre-checked that case, which two concurrent taps race past (measured: eight simultaneous taps
-- wrote eight rows, each inflating the student's lifetime attendance). This index is the guarantee.
--
-- Scope: type CHECKIN only. Staff-added days (type ADJUSTMENT) are also class-less and are governed by the daily
-- progress rule, not by this uniqueness. Voided rows are excluded, like the sibling index, so a valid replacement
-- after a void is accepted. Prisma's schema language cannot express a partial index; schema.prisma documents it.
CREATE UNIQUE INDEX "AttendanceRecord_unmatched_student_date_key"
  ON "AttendanceRecord"("studentId", "date")
  WHERE "classSessionId" IS NULL AND "type" = 'CHECKIN' AND "voidedAt" IS NULL;
