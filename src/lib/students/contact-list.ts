import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { ZONE } from "@/lib/scheduling/zone";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";

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
  currentBelt: string;
  currentBeltLabelEs: string;
  currentBeltLabelEn: string;
  currentBeltVisual: BeltVisualData;
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
 * page. Scoped by `getScopedDb`/`branchScopeWhere` the same way
 * `dashboard/page.tsx` already scopes `pendingCount`.
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
  context: TenantContext,
  thresholdDays: number = CONTACT_THRESHOLD_DAYS,
  today: { year: number; month: number; day: number } = currentCrDateParts(),
  now: DateTime = DateTime.now().setZone(ZONE),
): Promise<ContactListEntry[]> {
  const scope = branchScopeWhere(context);
  const students = await getScopedDb(context).student.findMany({
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

  // One query for the whole cohort's last attendance — same
  // `groupBy`/`_max` pattern `getRetentionList` (src/lib/analytics/retention.ts)
  // already uses — instead of a per-student `findFirst`. Only THEN do the
  // heavier `getAtBeltSummary`/`getCurrentPaymentPeriod` queries run, and
  // only for the students who actually qualify (7+ days absent or never
  // attended), not all ~150 active students on every dashboard load.
  const studentIds = students.map((student) => student.id);
  const lastAttendances = await prisma.attendanceRecord.groupBy({
    by: ["studentId"],
    where: { studentId: { in: studentIds }, organizationId: context.organizationId, type: "CHECKIN" },
    _max: { occurredAt: true },
  });
  const lastAttendanceByStudentId = new Map(lastAttendances.map((a) => [a.studentId, a._max.occurredAt ?? null]));

  const qualifying = students
    .map((student) => {
      const lastAttendanceAt = lastAttendanceByStudentId.get(student.id) ?? null;
      const daysAbsent = lastAttendanceAt
        ? Math.floor(now.diff(DateTime.fromJSDate(lastAttendanceAt, { zone: ZONE }), "days").days)
        : null;
      return { student, lastAttendanceAt, daysAbsent };
    })
    .filter(({ daysAbsent }) => isAbsentEnoughToContact(daysAbsent, thresholdDays));

  // Resolved ONCE for this whole batch, not once per student — see
  // resolvePromotionConfigMap's own doc comment on the N+1 this avoids.
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const results = await Promise.all(
    qualifying.map(async ({ student, lastAttendanceAt, daysAbsent }) => {
      const [summary, currentPeriod] = await Promise.all([
        getAtBeltSummary(student.id, context.organizationId, configByTrack),
        getCurrentPaymentPeriod(student.id, context.organizationId, today),
      ]);

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
        currentBeltLabelEs: summary.currentBeltLabelEs,
        currentBeltLabelEn: summary.currentBeltLabelEn,
        currentBeltVisual: summary.currentBeltVisual,
        atBeltCount: summary.atBeltCount,
        nextStripeAt:
          summary.nextTarget === "STRIPE" ? (summary.currentStripes + 1) * summary.attendancesPerStripe : null,
        lastAttendanceAt,
        daysAbsent,
        paymentStatus,
      } satisfies ContactListEntry;
    }),
  );

  return results.sort((a, b) => (b.daysAbsent ?? Infinity) - (a.daysAbsent ?? Infinity));
}
