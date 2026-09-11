import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { ZONE } from "@/lib/scheduling/zone";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { Belt } from "@/generated/prisma/client";

/**
 * REDESIGN_BRIEF.md §4.1 Task 4's own threshold — deliberately NOT
 * `getRetentionList`'s (`src/lib/analytics/retention.ts`) 30+/60+/90+ buckets,
 * which is a director-analytics feature with its own contract and no
 * INSTRUCTOR-visible variant. This is a separate, every-role list.
 */
export const CONTACT_THRESHOLD_DAYS = 7;

/**
 * Pure: is `daysAbsent` far enough gone to land on "Alumnos por contactar"?
 * `null` (no `CHECKIN` history at all) always qualifies — "far more than N
 * days", the same ruling `classifyRetentionBucket` makes for its own
 * never-attended case.
 */
export function isAbsentEnoughToContact(daysAbsent: number | null, thresholdDays: number): boolean {
  if (daysAbsent === null) return true;
  return daysAbsent >= thresholdDays;
}

export type ContactPaymentStatus = "OVERDUE" | "PAID" | "PENDING" | "PROMO" | "EXEMPT" | "NOT_RECORDED";

export interface ContactListEntry {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyName: string;
  phone: string;
  currentBelt: Belt;
  atBeltCount: number;
  /** Next-stripe threshold for the "X / Y" sub-line — `null` only for a
   * maxed-out belt with no further stripe to project toward. */
  nextStripeAt: number | null;
  lastAttendanceAt: Date | null;
  /** `null` means "never attended" — sorts as the most urgent case. */
  daysAbsent: number | null;
  paymentStatus: ContactPaymentStatus;
}

/**
 * "Alumnos por contactar" (REDESIGN_BRIEF.md §4.1 Task 4) — visible to every
 * staff role, unlike the weekly-attendance chart next to it on this same
 * page. Scoped by `academyScopeWhere` the same way `dashboard/page.tsx`
 * already scopes `pendingCount`.
 *
 * Per-student payment status is computed the same `getCurrentPaymentPeriod` +
 * `isOverdue` way `students/page.tsx`'s roster already does — that page shows
 * this to every role with no extra gate, so doing the same here doesn't
 * loosen anything (`listOverdueStudents`'s ADMIN/DIRECTOR-only restriction is
 * about the aggregated overdue-payments panel, not per-student status).
 *
 * Sorted worst-first (never-attended, then longest absence), matching
 * `getRetentionList`'s "most urgent outreach target on top" convention.
 */
export async function listStudentsToContact(
  session: StaffSession,
  thresholdDays: number = CONTACT_THRESHOLD_DAYS,
  today: { year: number; month: number; day: number } = currentCrDateParts(),
  now: DateTime = DateTime.now().setZone(ZONE),
): Promise<ContactListEntry[]> {
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
      phone: true,
      homeAcademy: { select: { name: true } },
    },
  });
  if (students.length === 0) return [];

  const results = await Promise.all(
    students.map(async (student) => {
      const [lastAttendance, summary, currentPeriod] = await Promise.all([
        prisma.attendanceRecord.findFirst({
          where: { studentId: student.id, type: "CHECKIN" },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        }),
        getAtBeltSummary(student.id),
        getCurrentPaymentPeriod(student.id, today),
      ]);

      const daysAbsent = lastAttendance
        ? Math.floor(now.diff(DateTime.fromJSDate(lastAttendance.occurredAt, { zone: ZONE }), "days").days)
        : null;

      if (!isAbsentEnoughToContact(daysAbsent, thresholdDays)) return null;

      const paymentStatus: ContactPaymentStatus = isOverdue(currentPeriod, today)
        ? "OVERDUE"
        : currentPeriod
          ? currentPeriod.status
          : "NOT_RECORDED";

      return {
        studentId: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        homeAcademyName: student.homeAcademy.name,
        phone: student.phone,
        currentBelt: summary.currentBelt,
        atBeltCount: summary.atBeltCount,
        nextStripeAt: summary.nextStripeAt,
        lastAttendanceAt: lastAttendance?.occurredAt ?? null,
        daysAbsent,
        paymentStatus,
      } satisfies ContactListEntry;
    }),
  );

  return results
    .filter((entry): entry is ContactListEntry => entry !== null)
    .sort((a, b) => (b.daysAbsent ?? Infinity) - (a.daysAbsent ?? Infinity));
}
