import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";

export interface OverdueStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyName: string;
  /**
   * The most recent month this student has a `PaymentPeriod` row with
   * status `PAID`, formatted as a zero-padded `"YYYY-MM"` string — plain and
   * locale-independent by design, matching how `PromotionCandidate` hands
   * the page a raw `Belt` enum rather than a pre-translated label; the page
   * owns locale formatting, this module owns data. `null` when the student
   * has never had a `PAID` period (e.g. brand new).
   */
  lastPaidMonth: string | null;
}

/**
 * Dashboard "payments overdue" panel (spec §4.3) — ADMIN/DIRECTOR only,
 * full stop. Unlike `promotion-queue.ts`'s `listPromotionQueue`/
 * `listApproachingStudents` (which INSTRUCTOR can view read-only, spec §3),
 * this feature has no INSTRUCTOR-visible variant at all, so the gate can't
 * be left to the caller/page to hide a button — it's enforced right here,
 * against the `session.role` the caller already resolved, the same
 * enforcement `confirmPromotion` (`dashboard/promotion-actions.ts`) applies
 * via `requireStaffSession(["ADMIN", "DIRECTOR"])`. This function can't call
 * that helper itself (it takes an already-resolved `StaffSession`, not a
 * fresh cookie-bound one — same shape as `listPromotionQueue`), so the
 * equivalent check is inlined instead of trusted away.
 */
export async function listOverdueStudents(
  session: StaffSession,
  // Optional/defaulted exactly like `perform-check-in.ts`'s `now?: Date` —
  // production callers never pass this, so they always get a fresh
  // `currentCrDateParts()` read; tests inject a fixed value so the cutoff-day
  // boundary can be exercised without fighting the real wall clock. Passed
  // straight through to `getCurrentPaymentPeriod` too, so the period lookup
  // and the overdue check always agree on what "today" is — see that
  // module's own doc comment on why a second, independent "what month is it"
  // resolution must never be written here.
  today: { year: number; month: number; day: number } = currentCrDateParts(),
): Promise<OverdueStudent[]> {
  if (session.role !== "ADMIN" && session.role !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }

  const scope = academyScopeWhere(session);
  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      // academyScopeWhere returns a fragment keyed `academyId`, but
      // Student's tenancy column is `homeAcademyId` — same translation
      // promotion-queue.ts's classifyActiveStudents and dashboard/page.tsx's
      // pendingCount query already establish; see academyScopeWhere's own
      // doc comment on why the fragment can't be spread directly.
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeAcademy: { select: { name: true } },
    },
  });

  const results = await Promise.all(
    students.map(async (student) => {
      // Reused verbatim from Task 2 — never a second, drifting
      // implementation of "resolve a student's current-month PaymentPeriod".
      const period = await getCurrentPaymentPeriod(student.id, today);
      if (!isOverdue(period, today)) return null;

      const lastPaid = await prisma.paymentPeriod.findFirst({
        where: { studentId: student.id, status: "PAID" },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        select: { year: true, month: true },
      });

      return {
        studentId: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        homeAcademyName: student.homeAcademy.name,
        lastPaidMonth: lastPaid ? `${lastPaid.year}-${String(lastPaid.month).padStart(2, "0")}` : null,
      };
    }),
  );

  return results.filter((r): r is OverdueStudent => r !== null);
}
