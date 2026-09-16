/**
 * Shared Prisma error predicates.
 *
 * `isUniqueConstraintError` was previously duplicated verbatim in
 * `src/lib/kiosk/perform-check-in.ts` and
 * `src/app/[locale]/(staff)/admin/schedule/actions.ts`; both now import it from here.
 *
 * Deliberately a structural check rather than an `instanceof
 * Prisma.PrismaClientKnownRequestError` test: under the driver-adapter setup
 * an error can cross a module/realm boundary (and the client is generated into
 * `src/generated/prisma`), so identity checks are brittle where reading the
 * documented `code` is not.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return hasPrismaCode(error, "P2002");
}

/**
 * `P2025` — "An operation failed because it depends on one or more records
 * that were required but not found." Raised by `findUniqueOrThrow`/
 * `findFirstOrThrow` when the queried row doesn't exist. Used by
 * `promotion-queue.ts`'s `classifyActiveStudents` to recognize a vanished
 * student (from `getAtBeltSummary`'s internal `findUniqueOrThrow`).
 */
export function isNotFoundError(error: unknown): boolean {
  return hasPrismaCode(error, "P2025");
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
