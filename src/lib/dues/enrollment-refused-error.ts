/**
 * Enrollment/resume integration plan §7.6: thrown INSIDE `prisma.$transaction` by both `approveStudent`
 * (`[id]/actions.ts`) and `createStudent` (`create-student-action.ts`) once a provisional write (the student row for
 * staff-creation, the assignment row for either path) already happened — never `return`ed, since Prisma only rolls
 * back a `$transaction` callback on a thrown exception (the same `PackagePurchaseRefusedError`/`ResumeChargeRefusedError`
 * pattern this ledger already uses elsewhere). Caught OUTSIDE `$transaction` by each action and converted to its own
 * typed `ActionState` error, after rollback has actually happened.
 */
export type EnrollmentRefusalReason =
  | "unsupportedEnrollmentPlan"
  | "inapplicable"
  | "staleVersion"
  | "currencyMismatch"
  | "requiresAdmin"
  | "planConflict";

export class EnrollmentRefusedError extends Error {
  constructor(public readonly reason: EnrollmentRefusalReason) {
    super(`enrollment refused: ${reason}`);
  }
}
