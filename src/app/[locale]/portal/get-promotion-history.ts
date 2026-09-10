import { prisma } from "@/lib/prisma";
import type { Belt } from "@/generated/prisma/client";

export type PromotionHistoryEntry = {
  id: string;
  fromBelt: Belt;
  fromStripes: number;
  toBelt: Belt;
  toStripes: number;
  awardedAt: Date;
  notes: string | null;
};

/**
 * The student portal's own copy of
 * `src/app/[locale]/students/[id]/get-promotion-history.ts` — same query
 * shape (`prisma.promotion.findMany`, ordered `awardedAt desc`), called with
 * `session.studentId` instead of a route-param-derived id. Deliberately does
 * NOT select/join `awardedBy` the way the staff version does: a staff
 * colleague's login email is fine to show another staff member, but the
 * portal is a lower trust tier — every student would otherwise see internal
 * staff/admin email addresses. Spec §4.2 only asks for "promotion history",
 * not who awarded it, so the field is simply omitted here rather than
 * fetched-but-unrendered.
 *
 * Deliberately a SEPARATE file rather than an import from the staff-only
 * `students/[id]/` directory, even though the query is nearly identical:
 * that directory's copy trusts its `studentId` argument BECAUSE its sole
 * caller (`students/[id]/page.tsx`) has already run it through
 * `getStudentForStaff`'s academy-scope check first — the safety of that
 * function is coupled to being called only after that check. This portal
 * page has no such check to depend on (and needs none): `studentId` here
 * always comes from `requireStudentSession()`, i.e. the caller's OWN student
 * row, never a route param an attacker could substitute another student's id
 * into. That is a different, equally-valid safety argument, not a weaker
 * one — but importing the staff version would wrongly imply this file
 * inherits a scope check it doesn't have and doesn't need, and would put a
 * customer-reachable code path inside a staff-only route tree. Physically
 * separate files keep each safety argument legible on its own.
 *
 * Same two build/security notes as the staff version apply here too: this is
 * a plain function (not a "use server" action) so an arbitrary caller can't
 * invoke it with someone else's id, and it stays out of any file a Client
 * Component imports from so Prisma's Node-only runtime never gets pulled
 * into the browser bundle.
 */
export async function getOwnPromotionHistory(studentId: string): Promise<PromotionHistoryEntry[]> {
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
    },
  });

  return promotions.map((promotion) => ({
    id: promotion.id,
    fromBelt: promotion.fromBelt,
    fromStripes: promotion.fromStripes,
    toBelt: promotion.toBelt,
    toStripes: promotion.toStripes,
    awardedAt: promotion.awardedAt,
    notes: promotion.notes,
  }));
}
