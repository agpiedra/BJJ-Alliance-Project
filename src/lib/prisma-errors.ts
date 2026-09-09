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

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
