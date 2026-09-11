import { prisma } from "@/lib/prisma";
import { isAcademyInScope, type StaffSession } from "@/lib/auth/session";

/**
 * Plain function — NOT a "use server" action, and deliberately kept out of
 * `actions.ts` (which the edit/archive/regenerate client components import
 * directly). Two independent reasons, matching Task 7's
 * `students/actions.ts` split:
 *
 * 1. Security: this takes `session: StaffSession` as a plain parameter
 *    rather than deriving it itself from the request. A "use server" export
 *    is invocable directly by anyone who can reach its action id with
 *    whatever serializable payload they send — so if this were a Server
 *    Action, a caller could forge `{ role: "ADMIN", academyIds: "ALL" }` and
 *    read any student regardless of academy. It's safe only because the
 *    detail page (a Server Component) is the sole caller and always passes a
 *    session it just obtained from `requireStaffSession()`.
 * 2. Build correctness: this module imports Prisma (Node-only). Mixing it
 *    into a file that a Client Component also imports from (the edit form /
 *    archive button / regenerate button all import from `./actions`) made
 *    Turbopack try to bundle Prisma's runtime for the browser and fail
 *    outright — verified during Task 7. Keeping this in its own module, only
 *    ever imported by `page.tsx` (a Server Component), avoids that.
 *
 * Returns `null` — never a distinguishable "forbidden" — when the student
 * exists but is outside `session`'s academy scope, so an out-of-scope staff
 * session (e.g. a DIRECTOR guessing another academy's student id) gets the
 * same result as a genuinely nonexistent id. The caller (`page.tsx`) turns
 * `null` into `notFound()`.
 */
export async function getStudentForStaff(session: StaffSession, studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { homeAcademy: { select: { id: true, name: true, slug: true } } },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return null;
  }

  return student;
}
