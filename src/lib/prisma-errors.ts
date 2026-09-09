/**
 * Shared Prisma error predicates.
 *
 * `isUniqueConstraintError` was previously duplicated verbatim in
 * `src/lib/kiosk/perform-check-in.ts` and
 * `src/app/[locale]/admin/schedule/actions.ts`; both now import it from here.
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
 * `findUniqueOrThrow`/`findFirstOrThrow` raise this (Prisma P2025) when
 * nothing matches. Used by `promotion-queue.ts`'s per-student classification
 * to tolerate a row vanishing between an admin-wide scan and that row's own
 * per-student lookup (a genuine, reproducible TOCTOU — see that file's
 * `classifyActiveStudents`) without letting one vanished row fail every
 * other student's classification in the same batch.
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
