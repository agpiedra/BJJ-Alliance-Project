import { getScopedDb } from "@/lib/tenant/scoped-client";
import { branchScopeWhere } from "@/lib/tenant/context";
import type { AccessContext } from "@/lib/tenant/types";
import { Track } from "@/generated/prisma/client";

export interface ActiveStudentCounts {
  total: number;
  kids: number;
  adults: number;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-iii: separate kids/adults
 * active-student counts alongside the existing total — the same nav-badge/
 * dashboard area revision 23 found leaking a platform-wide count via the
 * raw client. Both breakdown queries go through `getScopedDb` exactly like
 * the total, so the tenant guard (`tenant-guard.ts`) would throw before
 * either could repeat that leak.
 *
 * `total === kids + adults` always holds: `Student.track` is a NOT NULL
 * column with a DEFAULT (migration 20260914051511_phase2_promotion_schema_expand
 * backfilled every pre-existing row to ADULT), and `Track` has exactly two
 * values — no null, unset, or third state a student could fall into. That
 * guarantee is enforced by the schema, not by this function; the required
 * regression test asserts it against real query results directly, because
 * a filter whose two halves don't add up to the whole is exactly how a
 * student silently disappears from every view.
 */
export async function getActiveStudentCounts(context: AccessContext): Promise<ActiveStudentCounts> {
  const scope = branchScopeWhere(context);
  const whereFor = (track?: Track) => ({
    status: "ACTIVE" as const,
    ...(track ? { track } : {}),
    ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
  });

  const [total, kids, adults] = await Promise.all([
    getScopedDb(context).student.count({ where: whereFor() }),
    getScopedDb(context).student.count({ where: whereFor(Track.KIDS) }),
    getScopedDb(context).student.count({ where: whereFor(Track.ADULT) }),
  ]);

  return { total, kids, adults };
}
