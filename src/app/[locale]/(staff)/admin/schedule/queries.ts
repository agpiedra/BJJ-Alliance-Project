import { prisma } from "@/lib/prisma";
import { DayOfWeek } from "@/generated/prisma/client";

/** Prisma enum order (schema.prisma) already runs Monday -> Sunday — this
 * just turns that into a sortable index, since a `DayOfWeek` column sorts
 * alphabetically by its string value in SQL/JS, not calendar order. */
const DAY_ORDER: Record<DayOfWeek, number> = {
  MONDAY: 0,
  TUESDAY: 1,
  WEDNESDAY: 2,
  THURSDAY: 3,
  FRIDAY: 4,
  SATURDAY: 5,
  SUNDAY: 6,
};

/**
 * Plain function — NOT a "use server" action, and deliberately kept out of
 * this directory's `actions.ts` (which carries a file-level "use server"
 * directive for `createClassSession`/`updateClassSession`/
 * `deactivateClassSession`): a "use server" directive makes every export of
 * that file independently invocable by its action id from any browser,
 * session or not — folding this into `actions.ts` would turn an
 * unauthenticated request into a working way to read any academy's full
 * class schedule.
 *
 * Its one caller, `admin/schedule/page.tsx`, already resolved a
 * `TenantContext` via `requireTenantContext(["ADMIN"])` before calling this,
 * so `organizationId` here is a real tenant filter, not a formality — this
 * function used to also feed the public, unauthenticated home page
 * (`home-data.ts`, removed in revision 23) via a bare `academyId` filter,
 * which is exactly the shape the base-client tenant guard now rejects.
 *
 * Build-correctness note (still applies): this module imports Prisma
 * (Node-only). The write actions in `actions.ts` are imported by several
 * Client Components (the create form, the per-row edit form, the deactivate
 * button). If this function lived in that same "use server" file, every one
 * of those Client Components would pull Prisma's runtime into the browser
 * bundle — the exact Turbopack/webpack leak Phase 2 hit and fixed by
 * splitting `students/actions.ts` (plain) from
 * `students/create-student-action.ts` ("use server").
 *
 * Returns every session for the academy, active and inactive alike — the
 * admin table intentionally shows both (visually distinguished), so
 * deactivated sessions stay reviewable/reactivatable-by-edit rather than
 * disappearing.
 */
export async function listClassSessions(organizationId: string, academyId: string) {
  const sessions = await prisma.classSession.findMany({ where: { organizationId, academyId } });

  return sessions.sort((a, b) => {
    const dayDiff = DAY_ORDER[a.dayOfWeek] - DAY_ORDER[b.dayOfWeek];
    if (dayDiff !== 0) return dayDiff;
    return a.startTime.localeCompare(b.startTime);
  });
}
