import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { currentCrDateParts, getCurrentPaymentPeriod, type CurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";

/**
 * REDESIGN_BRIEF.md Phase 6 §6.3's stat-row buckets: "Al día" (PAID),
 * "Pendiente" (no row yet, or a PENDING row, either one still inside the
 * grace period), "Atrasado" (`isOverdue`), "Promoción o beca" (PROMO or
 * EXEMPT — ruling: EXEMPT/"exonerado" counts as current, never as debt, but
 * it is still a waiver, not a real payment, so it belongs in this bucket
 * rather than "Al día"). Reuses `getCurrentPaymentPeriod` + `isOverdue`
 * verbatim (never re-derives the PAID/PENDING/PROMO/EXEMPT-vs-overdue
 * classification `overdue.ts`/`get-current-period.ts` already own).
 */
export type PaymentBucket = "PAID" | "PENDING" | "OVERDUE" | "PROMO_OR_EXEMPT";

export interface CurrentPaymentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  homeAcademyName: string;
  bucket: PaymentBucket;
  period: CurrentPaymentPeriod;
}

function bucketFor(period: CurrentPaymentPeriod, overdue: boolean): PaymentBucket {
  if (overdue) return "OVERDUE";
  if (!period) return "PENDING";
  if (period.status === "PAID") return "PAID";
  if (period.status === "PROMO" || period.status === "EXEMPT") return "PROMO_OR_EXEMPT";
  return "PENDING";
}

/**
 * Pagos page's core data (spec §6.3) — unlike `list-overdue.ts`'s
 * `listOverdueStudents` (an ADMIN/DIRECTOR-only dashboard widget), this has
 * no role gate of its own: REDESIGN_BRIEF.md Phase 8 gives INSTRUCTOR a
 * read-only view of Pagos ("admin layout minus Pagos WRITE access"), so this
 * query must be reachable by every staff role. The page itself hides the
 * "Registrar pago" card and the write actions in the table from
 * non-ADMIN/DIRECTOR sessions; `recordPayment` re-enforces that gate
 * server-side regardless of what the UI shows.
 */
export async function listCurrentPaymentStatus(
  session: StaffSession,
  today: { year: number; month: number; day: number } = currentCrDateParts(),
): Promise<CurrentPaymentRow[]> {
  const scope = academyScopeWhere(session);
  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeAcademyId: true,
      homeAcademy: { select: { name: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return Promise.all(
    students.map(async (student) => {
      const period = await getCurrentPaymentPeriod(student.id, today);
      const overdue = isOverdue(period, today);
      return {
        studentId: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        homeAcademyId: student.homeAcademyId,
        homeAcademyName: student.homeAcademy.name,
        bucket: bucketFor(period, overdue),
        period,
      };
    }),
  );
}
