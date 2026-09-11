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
 * `deactivateClassSession`). Two independent reasons, matching
 * `students/actions.ts`'s doc comment on `listStudents`:
 *
 * 1. Security: this function takes a bare `academyId` string with no
 *    session parameter at all — no scoping logic is needed, but NOT because
 *    of who calls it. There are now two callers: the ADMIN-gated
 *    `admin/schedule/page.tsx` (a Server Component that calls
 *    `requireStaffSession(["ADMIN"])` first) AND the fully unauthenticated
 *    `src/app/[locale]/home-data.ts`, which feeds the public home page. This
 *    is safe today only because `ClassSession` (see `prisma/schema.prisma`)
 *    carries no sensitive fields — just schedule metadata (day/time,
 *    duration, class name/type, active flag) — nothing per-person, no PII,
 *    no financial data, no internal-only column. The safety argument lives
 *    in the DATA, not the caller: if anyone adds a sensitive field to
 *    `ClassSession` in the future (an instructor's private note, an internal
 *    cost figure, etc.), do NOT assume the ADMIN gate protects it — the
 *    public caller reaches this same function unfiltered. At that point
 *    split this into two functions: a full version for staff and a
 *    restricted-`select` version for public use.
 *    Separately, a "use server" directive makes every export of that file
 *    independently invocable by its action id from any browser, session or
 *    not — folding this into `actions.ts` would turn an unauthenticated
 *    request into a working way to read any academy's full class schedule
 *    (not just the one public preview `home-data.ts` already exposes on
 *    purpose).
 * 2. Build correctness: this module imports Prisma (Node-only). The write
 *    actions in `actions.ts` are imported by several Client Components
 *    (the create form, the per-row edit form, the deactivate button). If
 *    this function lived in that same "use server" file, every one of those
 *    Client Components would pull Prisma's runtime into the browser bundle
 *    — the exact Turbopack/webpack leak Phase 2 hit and fixed by splitting
 *    `students/actions.ts` (plain) from `students/create-student-action.ts`
 *    ("use server").
 *
 * Returns every session for the academy, active and inactive alike — the
 * admin table intentionally shows both (visually distinguished), so
 * deactivated sessions stay reviewable/reactivatable-by-edit rather than
 * disappearing.
 */
export async function listClassSessions(academyId: string) {
  const sessions = await prisma.classSession.findMany({ where: { academyId } });

  return sessions.sort((a, b) => {
    const dayDiff = DAY_ORDER[a.dayOfWeek] - DAY_ORDER[b.dayOfWeek];
    if (dayDiff !== 0) return dayDiff;
    return a.startTime.localeCompare(b.startTime);
  });
}
