import { Prisma } from "@/generated/prisma/client";

/**
 * Server-only (it imports the Prisma client, so it must never be pulled into a client component; the client-safe slug helpers
 * live in ./slug). Whether a database error is the unique-index refusal of an Organization.slug, and nothing else.
 *
 * Registration checks the slug first and creates the organization later, so two people submitting the same slug together can both
 * pass the check; the unique index `Organization_slug_key` then refuses the second. That refusal is a normal outcome (the slug
 * is taken), not a crash, and the caller turns it into the same `slugTaken` result the pre-check returns. It must stay narrow: a
 * unique violation on any other model or constraint, another Prisma error, or any other failure is NOT a slug conflict and must
 * reach the caller unchanged, so a real database fault is never disguised as "that URL is taken".
 *
 * Prisma reports the constraint differently by engine: the driver-adapter path used here puts it at
 * `meta.driverAdapterError.cause.constraint.{index,fields}`, the classic engine at `meta.target`. Both name the model in
 * `meta.modelName`.
 */
const SLUG_CONSTRAINT_NAMES = new Set(["slug", "Organization_slug_key"]);

function namesIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export function isSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const meta = (error.meta ?? {}) as { modelName?: unknown; target?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } } };
  if (meta.modelName !== "Organization") return false;
  const constraint = meta.driverAdapterError?.cause?.constraint;
  return [...namesIn(meta.target), ...namesIn(constraint?.index), ...namesIn(constraint?.fields)].some((name) => SLUG_CONSTRAINT_NAMES.has(name));
}
