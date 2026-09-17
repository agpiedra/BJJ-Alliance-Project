import { prisma } from "@/lib/prisma";
import type { PromotionSource } from "@/generated/prisma/client";

export type PromotionHistoryEntry = {
  id: string;
  fromBelt: string;
  fromBeltLabelEs: string;
  fromBeltLabelEn: string;
  fromStripes: number;
  toBelt: string;
  toBeltLabelEs: string;
  toBeltLabelEn: string;
  toStripes: number;
  awardedAt: Date;
  awardedByName: string;
  source: PromotionSource;
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
export async function getPromotionHistory(
  studentId: string,
  organizationId: string,
): Promise<PromotionHistoryEntry[]> {
  const promotions = await prisma.promotion.findMany({
    where: { studentId, organizationId },
    orderBy: { awardedAt: "desc" },
    select: {
      id: true,
      fromRank: { select: { code: true, labelEs: true, labelEn: true } },
      fromStripes: true,
      toRank: { select: { code: true, labelEs: true, labelEn: true } },
      toStripes: true,
      awardedAt: true,
      notes: true,
      source: true,
      awardedBy: { select: { email: true } },
    },
  });

  return promotions.map((promotion) => ({
    id: promotion.id,
    fromBelt: promotion.fromRank.code,
    fromBeltLabelEs: promotion.fromRank.labelEs,
    fromBeltLabelEn: promotion.fromRank.labelEn,
    fromStripes: promotion.fromStripes,
    toBelt: promotion.toRank.code,
    toBeltLabelEs: promotion.toRank.labelEs,
    toBeltLabelEn: promotion.toRank.labelEn,
    toStripes: promotion.toStripes,
    awardedAt: promotion.awardedAt,
    // Phase 2d: `awardedById` is null for an AUTO award (no human actor to
    // invent one for) — the card renders the AUTO/MANUAL/CORRECTION badge
    // from `source` itself, so this fallback is purely "no name to show,"
    // not the primary signal for automatic awards.
    awardedByName: promotion.awardedBy?.email ?? "—",
    source: promotion.source,
    notes: promotion.notes,
  }));
}
