import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { ZONE } from "@/lib/scheduling/zone";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { buildProgressView } from "@/lib/promotion/progress-view";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import { listRosterPaymentFacts, toRosterLedgerDisplay, type RosterLedgerEntry } from "@/lib/dues/roster-payment-facts-queries";
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

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.3: a discriminated replacement, never a silent reinterpretation of the
 * legacy enum into a ledger fact. `source: "ledger"` reuses the roster's own already-approved independent-facts
 * display (`RosterLedgerEntry`/`toRosterLedgerDisplay`) exactly as-is — never a collapsed "healthy"/"not healthy"
 * boolean (§3/§5's own withdrawal of that reasoning). A caller must handle both branches; there is no default that
 * silently treats "no debt" as "paid," "covered," or "eligible."
 */
export type ContactPaymentInfo = { source: "legacy"; status: ContactPaymentStatus } | { source: "ledger"; entry: RosterLedgerEntry };

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
  paymentStatus: ContactPaymentInfo;
}

/**
 * "Alumnos por contactar" (REDESIGN_BRIEF.md §4.1 Task 4) — visible to every
 * staff role, unlike the weekly-attendance chart next to it on this same
 * page. Scoped by `getScopedDb`/`branchScopeWhere` the same way
 * `dashboard/page.tsx` already scopes `pendingCount`.
 *
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.3/Decision 2: this list's own population query, attendance selection, and
 * authorization are UNCHANGED by the ledger cutover — it stays `status: "ACTIVE"`-only (attendance-driven
 * outreach, a different purpose from the dashboard/digest's debt-surfacing panels, which DO extend to
 * inactive/archived students). Only the per-student payment-status FACT changes with `ledgerActive`: inactive,
 * the legacy `getCurrentPaymentPeriod`/`isOverdue` per-student computation is unchanged; active, that legacy path
 * is never called at all (§6 "active paths skip legacy payment calculations") — one BATCHED
 * `listRosterPaymentFacts` call covers the whole qualifying cohort instead, reusing the roster's own
 * `toRosterLedgerDisplay` independent-facts display exactly as-is (never a collapsed boolean).
 *
 * Sorted worst-first (never-attended, then longest absence), matching
 * `getRetentionList`'s "most urgent outreach target on top" convention.
 */
export async function listStudentsToContact(
  context: TenantContext,
  ledgerActive: boolean,
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
    where: { studentId: { in: studentIds }, organizationId: context.organizationId, type: "CHECKIN", voidedAt: null },
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

  // ONE batched read for the whole qualifying cohort, reusing `listRosterPaymentFacts` exactly as the roster
  // already does — never a per-student loop under the ledger. `null` when inactive: the legacy per-student
  // branch below is used instead, and this is never computed at all.
  const ledgerFactsByStudentId = ledgerActive
    ? (await listRosterPaymentFacts(context, qualifying.map(({ student }) => student.id), now.toJSDate())).byStudentId
    : null;

  const results = await Promise.all(
    qualifying.map(async ({ student, lastAttendanceAt, daysAbsent }) => {
      const summary = await getAtBeltSummary(student.id, context.organizationId, configByTrack);

      let paymentStatus: ContactPaymentInfo;
      if (ledgerFactsByStudentId) {
        const fact = ledgerFactsByStudentId.get(student.id);
        const entry: RosterLedgerEntry = fact?.ok
          ? { kind: "ledger", display: toRosterLedgerDisplay(fact.facts, fact.todayIso) }
          : { kind: "unavailable" };
        paymentStatus = { source: "ledger", entry };
      } else {
        const currentPeriod = await getCurrentPaymentPeriod(student.id, context.organizationId, today);
        const status: ContactPaymentStatus = isOverdue(currentPeriod, today)
          ? "OVERDUE"
          : currentPeriod
            ? currentPeriod.status
            : "NOT_RECORDED";
        paymentStatus = { source: "legacy", status };
      }

      const progress = buildProgressView(summary);
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
        // The shared display shaping: the count is capped at the target (an eligible student is "30 / 30").
        atBeltCount: progress.current ?? progress.actualCount,
        nextStripeAt: summary.nextTarget === "STRIPE" ? progress.target : null,
        lastAttendanceAt,
        daysAbsent,
        paymentStatus,
      } satisfies ContactListEntry;
    }),
  );

  return results.sort((a, b) => (b.daysAbsent ?? Infinity) - (a.daysAbsent ?? Infinity));
}
