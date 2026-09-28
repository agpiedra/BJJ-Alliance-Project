import { Prisma } from "@/generated/prisma/client";

/**
 * Late-fee-assessment brief §6.3: a P2002 is not one thing. Extracted to its own dependency-free file (no `@/lib/prisma`, which
 * would eagerly require `DATABASE_URL` at import time) so this pure classification is unit-testable without a database.
 *
 * Whether a P2002 fired on a constraint belonging to `modelName`, identified from Prisma's own error metadata — never assumed.
 */
export function isUniqueViolationOn(error: unknown, modelName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (error.meta?.modelName === modelName) return true;
  const target = error.meta?.target;
  const targetText = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return targetText.includes(modelName);
}
