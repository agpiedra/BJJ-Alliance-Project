import { Prisma } from "@/generated/prisma/client";

/**
 * Late-fee-assessment brief §6.3, corrected: a P2002 must be identified by the CONSTRAINT that actually fired, not by which
 * table/model it belongs to — a table can have several unique constraints, and `error.meta.modelName` alone can't tell them
 * apart. Extracted to its own dependency-free file (no `@/lib/prisma`, which would eagerly require `DATABASE_URL` at import
 * time) so this pure classification is unit-testable without a database.
 *
 * The real shape (verified against this project's actual Prisma 7 + `@prisma/adapter-pg` setup by forcing a genuine duplicate-key
 * violation, not assumed): the driver's own Postgres error — including the constraint's index name — lives at
 * `error.meta.driverAdapterError.cause`, e.g. `{ kind: "UniqueConstraintViolation", constraint: { index: "User_email_key" }, ... }`.
 * `error.meta.target` does not exist at all in this shape (a fallback on it would be dead code); `error.meta.modelName` exists but
 * only names the table, not the specific constraint, which is exactly the imprecision this function fixes.
 *
 * Fails CLOSED for an unrecognized shape: if this project's Prisma/driver version ever changes how it reports the constraint,
 * this returns `false` rather than guessing — an unrecognized shape must surface as a genuinely unexpected error, never get
 * silently classified as a known conflict.
 */
export function isUniqueViolationOnConstraint(error: unknown, constraintIndexName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const cause = (
    error.meta as { driverAdapterError?: { cause?: { kind?: string; constraint?: { index?: string } } } } | undefined
  )?.driverAdapterError?.cause;
  return cause?.kind === "UniqueConstraintViolation" && cause?.constraint?.index === constraintIndexName;
}
