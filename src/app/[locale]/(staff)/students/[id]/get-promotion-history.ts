import { prisma } from "@/lib/prisma";
import type { Belt } from "@/generated/prisma/client";

export type PromotionHistoryEntry = {
  id: string;
  fromBelt: Belt;
  fromStripes: number;
  toBelt: Belt;
  toStripes: number;
  awardedAt: Date;
  awardedByName: string;
  notes: string | null;
};

/**
 * Plain function — NOT a "use server" action, deliberately kept out of
 * `actions.ts` (which the edit/archive/regenerate/approve client components
 * import from). Same two reasons as `get-student.ts`'s `getStudentForStaff`:
 *
 * 1. Security: this trusts `studentId` alone with no session/scope check of
 *    its own — the caller (`page.tsx`) has already resolved and scope-checked
 *    the student via `getStudentForStaff` before calling this, so a second,
 *    independent scope check here would be redundant, not defense in depth.
 *    Unlike `getStudentForStaff`, this doesn't even take a session param — it
 *    is safe only because `page.tsx` (a Server Component) is the sole caller,
 *    always after that scope check has already passed for this exact
 *    `studentId`. A "use server" export would be directly invocable by
 *    anyone with the action id and an arbitrary `studentId`, bypassing that
 *    ordering entirely.
 * 2. Build correctness: this module imports Prisma (Node-only). Verified via
 *    `pnpm build` + a client-bundle grep (see commit/report) that keeping it
 *    out of any file a Client Component imports from avoids Turbopack trying
 *    to bundle Prisma's runtime for the browser, the same failure Task 7 hit.
 *
 * `User` has no display-name field (`displayName`/`name`) — only `email` —
 * so `awardedByName` is sourced from `awardedBy.email` directly, matching how
 * staff identity is surfaced elsewhere in this codebase (staff authenticate
 * by email; there's no separate display-name concept for them, unlike
 * `Student.firstName`/`lastName`).
 */
export async function getPromotionHistory(studentId: string): Promise<PromotionHistoryEntry[]> {
  const promotions = await prisma.promotion.findMany({
    where: { studentId },
    orderBy: { awardedAt: "desc" },
    select: {
      id: true,
      fromBelt: true,
      fromStripes: true,
      toBelt: true,
      toStripes: true,
      awardedAt: true,
      notes: true,
      awardedBy: { select: { email: true } },
    },
  });

  return promotions.map((promotion) => ({
    id: promotion.id,
    fromBelt: promotion.fromBelt,
    fromStripes: promotion.fromStripes,
    toBelt: promotion.toBelt,
    toStripes: promotion.toStripes,
    awardedAt: promotion.awardedAt,
    awardedByName: promotion.awardedBy.email,
    notes: promotion.notes,
  }));
}
