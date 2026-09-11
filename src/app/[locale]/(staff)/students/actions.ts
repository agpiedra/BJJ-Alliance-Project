import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { Belt, StudentStatus, Prisma } from "@/generated/prisma/client";

export type StudentFilters = {
  search?: string;
  belt?: Belt;
  status?: StudentStatus;
  academyId?: string;
};

/**
 * Plain function — NOT a "use server" action, and deliberately kept out of
 * any file a Client Component imports from. Two independent reasons:
 *
 * 1. Security: this function takes `session: StaffSession` as a plain
 *    parameter rather than deriving it itself from the request. A "use
 *    server" export is invocable directly by anyone who can reach its
 *    action id, with whatever serializable payload they send — so if this
 *    were a Server Action, a caller could forge `{ role: "ADMIN",
 *    academyIds: "ALL" }` and read every academy's roster. It's safe only
 *    because the roster page (a Server Component) is the sole caller and
 *    always passes a session it just obtained from `requireStaffSession()`.
 * 2. Build correctness: this module imports Prisma (Node-only). Mixing it
 *    into a file that a Client Component also imports from (for
 *    `createStudent`, see `create-student-action.ts`) made Turbopack try to
 *    bundle Prisma's runtime for the browser and fail outright. Splitting
 *    the "use server" action into its own file — matching Task 6's
 *    `signup/actions.ts` shape exactly — avoids that.
 *
 * `academyScopeWhere(session)` returns a fragment keyed `academyId`, but
 * Student's tenancy column is `homeAcademyId` — so unlike a model that
 * literally has an `academyId` column, the fragment's key is translated to
 * `homeAcademyId` below and combined with the rest of the filters via an
 * `AND` array (never spread alongside another literal `academyId` /
 * `homeAcademyId` key in the same object — see the note in session.ts about
 * that exact collision bug).
 */
export async function listStudents(session: StaffSession, filters: StudentFilters = {}) {
  const scope = academyScopeWhere(session);
  const conditions: Prisma.StudentWhereInput[] = [];

  if (scope.academyId) {
    conditions.push({ homeAcademyId: scope.academyId });
  }

  // Only an ADMIN's session has an unrestricted scope (scope.academyId is
  // undefined above), so only ADMIN gets the Escazú/Escalante/Ambas filter
  // switcher (spec §1b). A DIRECTOR/INSTRUCTOR session is already fully
  // scoped by the fragment above; a client-submitted academyId from them
  // is silently ignored here rather than trusted.
  if (session.role === "ADMIN" && filters.academyId) {
    conditions.push({ homeAcademyId: filters.academyId });
  }

  if (filters.belt) {
    conditions.push({ currentBelt: filters.belt });
  }

  if (filters.status) {
    conditions.push({ status: filters.status });
  }

  const search = filters.search?.trim();
  if (search) {
    conditions.push({
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  return prisma.student.findMany({
    where: conditions.length > 0 ? { AND: conditions } : {},
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: { homeAcademy: { select: { id: true, name: true, slug: true } } },
  });
}
