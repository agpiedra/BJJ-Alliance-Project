import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext, branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { prisma } from "@/lib/prisma";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { BrandingReminderCard } from "./branding-reminder-card";
import { ZONE } from "@/lib/scheduling/zone";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { BarList, type BarListItem } from "@/components/ui/bar-list";
import { Heatmap, type HeatmapCell } from "@/components/ui/heatmap";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { buttonVariants } from "@/components/ui/button";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import {
  listApproachingStudents,
  listPromotionQueue,
  type PromotionCandidate,
} from "@/lib/students/promotion-queue";
import { listOverdueStudents, type OverdueStudent } from "@/lib/payments/list-overdue";
import { getActiveStudentCounts } from "@/lib/students/active-counts";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
type Belt = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";
import { resolveNextRank } from "@/lib/promotion/config";
import { getWeeklyAttendanceTrend } from "@/lib/analytics/retention";
import { getBeltDistribution } from "@/lib/analytics/progression";
import { getAttendanceByClass } from "@/lib/analytics/class-popularity";
import type { AnalyticsFilters } from "@/lib/analytics/filters";
import {
  getFranjaHeatmap,
  FRANJA_DAY_ORDER,
  FRANJA_WINDOW_WEEKS,
  TIME_BAND_ORDER,
} from "@/lib/analytics/franja-heatmap";
import { listStudentsToContact, CONTACT_THRESHOLD_DAYS, type ContactPaymentStatus } from "@/lib/students/contact-list";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { ConfirmPromotionButton } from "./confirm-promotion-button";
import { WeeklyAttendanceChart } from "./weekly-attendance-chart";
import { AttendanceByClassChart } from "./attendance-by-class-chart";
import { buildWhatsAppLink } from "./whatsapp-link";
import type { Prisma } from "@/generated/prisma/client";
import { cn } from "cn";

// Same reasoning as the roster page: the pending-approvals count is staff
// data that can change without a redeploy, so this page must never be
// statically frozen at build time.
export const dynamic = "force-dynamic";

/** §4.1 Task 2a's "8-week line+area chart" window — interpolated into the
 * chart's caption (`panel.weeklyChart.caption`) so the copy can never drift
 * from the actual query range, the same way `CONTACT_THRESHOLD_DAYS` and
 * `FRANJA_WINDOW_WEEKS` are interpolated into their own captions. */
const WEEKLY_CHART_WINDOW_WEEKS = 8;

const BELT_BAR_COLOR_CLASS: Record<Belt, string> = {
  WHITE: "bg-belt-white",
  BLUE: "bg-belt-blue",
  PURPLE: "bg-belt-purple",
  BROWN: "bg-belt-brown",
  BLACK: "bg-belt-black",
};

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/** Bounded name list for a stat tile's context line — Rule 5 ("numbers get
 * context") without letting a large roster blow out the tile's fixed height. */
function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max).join(", ");
  const remaining = names.length - max;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}

/**
 * REDESIGN_BRIEF.md §4.1 Task 4: "days absent (colored by severity)". The
 * threshold this list is built on is 7+ days (`CONTACT_THRESHOLD_DAYS`) —
 * everything on this table already qualifies, so severity only distinguishes
 * "just over the line" (warn) from "twice the threshold or never attended"
 * (bad), never a third "fine" state that would contradict the table's own
 * inclusion criteria.
 */
function daysAbsentSeverityClass(daysAbsent: number | null): string {
  if (daysAbsent === null || daysAbsent >= CONTACT_THRESHOLD_DAYS * 2) return "text-bad";
  return "text-warn";
}

function paymentStatusPillVariant(status: ContactPaymentStatus): "ok" | "warn" | "bad" | "accent" | "plain" {
  switch (status) {
    case "OVERDUE":
      return "bad";
    case "PENDING":
      return "warn";
    case "PROMO":
      return "accent";
    case "PAID":
    case "EXEMPT":
      return "ok";
    default:
      return "plain";
  }
}

function paymentStatusLabel(status: ContactPaymentStatus, tPaymentStatus: (key: string) => string): string {
  if (status === "OVERDUE") return tPaymentStatus("overdue");
  if (status === "NOT_RECORDED") return tPaymentStatus("notRecorded");
  return tPaymentStatus(status);
}

export default async function DashboardPage() {
  const context = await requireTenantContext();
  const t = await getTranslations("dashboard");
  const tBelt = await getTranslations("belt");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const tBand = await getTranslations("dashboard.panel.franjaHeatmap.bands");
  const tDay = await getTranslations("dayOfWeek");
  const locale = await getLocale();
  const now = DateTime.now().setZone(ZONE);

  // branchScopeWhere(context) returns a fragment keyed `academyId`, but
  // Student's tenancy column is `homeAcademyId` — spreading the fragment
  // directly would throw a Prisma validation error for any non-ADMIN
  // session (confirmed while manually verifying this task). Translate it
  // the same way src/app/[locale]/(staff)/students/actions.ts's listStudents does,
  // so a DIRECTOR/INSTRUCTOR only ever sees the pending count for their own
  // academy/academies — never a global count — and ADMIN sees every
  // pending student in their own organization (never another tenant's, via
  // `getScopedDb`, unconditionally).
  const scope = branchScopeWhere(context);
  const pendingCount = await getScopedDb(context).student.count({
    where: {
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
      status: "PENDING",
    },
  });

  // Payments-overdue panel (spec §4.3) has no INSTRUCTOR-visible variant at
  // all — unlike the promotion queue below, which INSTRUCTOR can view
  // read-only. Checked here, before the query even runs, so an INSTRUCTOR
  // session never executes a query whose result would just be thrown away;
  // `listOverdueStudents` also self-enforces this same gate against
  // `context.organizationRole`, so this is belt-and-suspenders, not the only check.
  // The same boolean also gates §4.1 Task 2's weekly-attendance chart and
  // belt-distribution panel below — both back onto `getWeeklyAttendanceTrend`
  // / `getBeltDistribution` (src/lib/analytics/{retention,progression}.ts),
  // which are themselves self-enforced ADMIN/DIRECTOR-only, so INSTRUCTOR
  // never sees that whole section, matching "keep the existing role-gating
  // exactly as it is today" for this dashboard.
  const canViewOverduePayments = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  // Both promotion queries scope by getScopedDb/branchScopeWhere internally (see
  // promotion-queue.ts) the same way pendingCount does above — a
  // DIRECTOR/INSTRUCTOR only ever sees their own academy/academies here too.
  const [promotionQueue, approachingStudents, overdueStudents] = await Promise.all([
    listPromotionQueue(context),
    listApproachingStudents(context),
    canViewOverduePayments ? listOverdueStudents(context) : Promise.resolve<OverdueStudent[]>([]),
  ]);

  // Confirming a promotion is ADMIN/DIRECTOR only (spec §3 excludes
  // INSTRUCTOR from promotions, same restriction confirmPromotion enforces
  // server-side) — mirrors student detail page's `canEdit` gate. INSTRUCTOR
  // sessions still see both lists in full, just without the button.
  const canConfirmPromotion = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  // §4.1 stat row: "Alumnos activos" / "Asistencias esta semana", plus last
  // week's count so the second tile can carry a real vs.-last-week
  // comparison (Rule 5), the same `.startOf("week")` ISO-week convention
  // `getWeeklyAttendanceTrend` already establishes for "this week" in CR time.
  const currentWeekStart = now.startOf("week");
  const currentWeekEnd = currentWeekStart.endOf("week");
  const previousWeekStart = currentWeekStart.minus({ weeks: 1 });
  const previousWeekEnd = currentWeekStart.minus({ milliseconds: 1 });

  const weeklyAttendanceConditions = (from: DateTime, to: DateTime): Prisma.AttendanceRecordWhereInput => ({
    AND: [
      branchScopeWhere(context),
      { type: "CHECKIN" },
      { occurredAt: { gte: from.toJSDate(), lte: to.toJSDate() } },
    ],
  });

  const [activeCounts, weeklyAttendanceCount, previousWeekAttendanceCount, academyRows] = await Promise.all([
    // Phase 3c-iii: separate kids/adults counts alongside the existing
    // total — the same nav-badge/dashboard area revision 23 found leaking a
    // platform-wide count via the raw client. getActiveStudentCounts scopes
    // every one of its three queries through getScopedDb, so the tenant
    // guard (tenant-guard.ts) would throw before any of them could repeat
    // that leak.
    getActiveStudentCounts(context),
    getScopedDb(context).attendanceRecord.count({ where: weeklyAttendanceConditions(currentWeekStart, currentWeekEnd) }),
    getScopedDb(context).attendanceRecord.count({ where: weeklyAttendanceConditions(previousWeekStart, previousWeekEnd) }),
    getScopedDb(context).academy.findMany({
      where: {
        ...(scope.academyId ? { id: { in: scope.academyId.in } } : {}),
      },
      orderBy: { name: "asc" },
      select: { name: true },
    }),
  ]);
  const { total: activeStudentCount, kids: activeKidsCount, adults: activeAdultsCount } = activeCounts;

  const academyLabel = academyRows.map((academy) => academy.name).join(` ${t("panel.academyJoin")} `);

  const attendanceDiff = weeklyAttendanceCount - previousWeekAttendanceCount;
  const attendanceDelta =
    attendanceDiff === 0
      ? undefined
      : {
          direction: (attendanceDiff > 0 ? "up" : "down") as "up" | "down",
          label: t(attendanceDiff > 0 ? "panel.stats.weeklyAttendance.deltaUp" : "panel.stats.weeklyAttendance.deltaDown", {
            diff: Math.abs(attendanceDiff),
          }),
        };

  const readyNote = joinNames(promotionQueue.map((c) => `${c.firstName} ${c.lastName}`));
  const overdueNote = joinNames(overdueStudents.map((s) => `${s.firstName} ${s.lastName}`));

  const eyebrowDate = capitalizeFirst(
    new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: ZONE,
    })
      .format(now.toJSDate())
      .replace(",", ""),
  );

  // §4.1 Task 2: weekly attendance trend + belt distribution — ADMIN/DIRECTOR
  // only (see `canViewOverduePayments`'s doc comment above). Panel has no
  // filter controls, so this builds "last 8 weeks ending today" inline
  // instead of resolving one from search params (unlike the /dashboard/analytics
  // page); `academyId: null` defers entirely to the session's own scope,
  // exactly like `resolveAnalyticsFilters` does for a non-ADMIN session.
  //
  // Hoisted above the ADMIN/DIRECTOR gate (unlike before Phase 8): the
  // attendance-by-class chart below shares this exact same window and is
  // NOT ADMIN/DIRECTOR-only — see getAttendanceByClass's own doc comment on
  // why INSTRUCTOR reaches it too. `getWeeklyAttendanceTrend`'s bucket list
  // runs `from.startOf("week")` to `to.startOf("week")` inclusive, so `from`
  // must already sit on a week boundary `WEEKLY_CHART_WINDOW_WEEKS - 1`
  // weeks back — otherwise the range spans one extra bucket, and that
  // leftmost bucket only counts partial data (`occurredAt >= from`, not
  // from the start of that week).
  const eightWeekFilters: AnalyticsFilters = {
    from: now.minus({ weeks: WEEKLY_CHART_WINDOW_WEEKS - 1 }).startOf("week"),
    to: now.endOf("day"),
    academyId: null,
  };

  let weeklyTrend: Array<{ weekStart: string; count: number }> = [];
  let beltDistribution: Array<{ belt: Belt; count: number }> = [];
  let stripeThresholdByBelt = new Map<Belt, number>();
  if (canViewOverduePayments) {
    const [trend, distribution, stripeThresholdRows] = await Promise.all([
      getWeeklyAttendanceTrend(context, eightWeekFilters),
      getBeltDistribution(context, eightWeekFilters),
      // Real thresholds (30/65/75/85 in the seeded default data), never
      // hardcoded — the belt-distribution caption states whatever BeltRank
      // actually says. Organization-owned, no per-branch override (Phase 2:
      // branch overrides never existed in real data and are undefined once
      // a student's attendance pools cross-branch into one progression) —
      // this caption states one general rule, never another tenant's.
      getScopedDb(context).beltRank.findMany({
        where: {
          track: "ADULT",
          code: { in: ["WHITE", "BLUE", "PURPLE", "BROWN"] },
        },
        select: { code: true, attendancesPerStripe: true },
      }),
    ]);
    weeklyTrend = trend;
    beltDistribution = distribution;
    stripeThresholdByBelt = new Map(
      stripeThresholdRows.map((row) => [row.code as Belt, row.attendancesPerStripe ?? 0]),
    );
  }

  // Phase 8 — every staff role (ADMIN/DIRECTOR/INSTRUCTOR) reaches this,
  // scoped to their own assigned academies via branchScopeWhere inside
  // getAttendanceByClass itself, the same mechanism every other
  // INSTRUCTOR-visible query on this page already uses — not a new rule.
  const attendanceByClass = await getAttendanceByClass(context, eightWeekFilters, locale);

  const beltDistributionHasData = beltDistribution.some((row) => row.count > 0);
  const beltBarItems: BarListItem[] = beltDistribution.map((row) => ({
    key: row.belt,
    label: tBelt(row.belt),
    value: row.count,
    colorClassName: BELT_BAR_COLOR_CLASS[row.belt],
  }));

  // §4.1 Task 3a: "Asistencia promedio por franja" — every role, no gate.
  const franjaGrid = await getFranjaHeatmap(context);
  const franjaRowLabels = TIME_BAND_ORDER.map((band) => tBand(band));
  const franjaColLabels = FRANJA_DAY_ORDER.map((day) => tDay(day).slice(0, 3));
  const franjaCells: HeatmapCell[][] = TIME_BAND_ORDER.map((_, bandIndex) =>
    FRANJA_DAY_ORDER.map((_, dayIndex) => ({ value: franjaGrid[dayIndex][bandIndex].average })),
  );
  // Same "don't render a full grid of zeros" guard `WeeklyAttendanceChart`
  // already applies to its own data (`data.some(p => p.count > 0)`) — a
  // non-null cell with a 0 average is scheduled classes with zero recorded
  // attendance, not real signal to show a heatmap over.
  const franjaHasData = franjaCells.some((row) => row.some((cell) => cell.value !== null && cell.value > 0));

  // §4.1 Task 3b: "Cola de promociones" row text ("29 / 30 · 4.ª franja
  // blanca" / "63 / 65 · examen de morada"). `PromotionCandidate` alone
  // doesn't carry the threshold (Y) once a candidate has already crossed
  // it — `remainingAttendance` is clamped to 0 at that point — so this
  // reuses `getAtBeltSummary` (already built, already used internally by
  // `promotion-queue.ts`'s own classification) per candidate rather than a
  // second query; the list is always small (a handful of eligible students).
  // Resolved ONCE for this whole batch, not once per candidate — see
  // resolvePromotionConfigMap's own doc comment on the N+1 this avoids.
  const queueConfigByTrack = await resolvePromotionConfigMap(context.organizationId);
  const queueRows = await Promise.all(
    promotionQueue.map(async (candidate) => {
      const summary = await getAtBeltSummary(candidate.studentId, context.organizationId, queueConfigByTrack);
      if (candidate.status === "exam-eligible") {
        // Real catalog lookup (Phase 2c-ii) — replaces eligibility.ts's old
        // hardcoded BELT_ORDER array. A read/display path: a broken catalog
        // degrades to a blank belt name here rather than throwing and
        // taking down the whole dashboard for every viewer (see
        // resolveNextRank's own doc comment).
        const target = await resolveNextRank(context, summary.track, summary.currentRankOrder);
        const targetLabel = target ? (locale === "es" ? target.labelEs : target.labelEn) : "";
        return {
          candidate,
          detail: t("panel.promotionQueue.examRow", {
            current: summary.atBeltCount,
            target: summary.maxStripes * summary.attendancesPerStripe + summary.attendancesForExam,
            belt: targetLabel,
          }),
        };
      }
      return {
        candidate,
        detail: t("panel.promotionQueue.stripeRow", {
          current: summary.atBeltCount,
          target: (summary.currentStripes + 1) * summary.attendancesPerStripe,
          ordinal: summary.currentStripes + 1,
          belt: locale === "es" ? summary.currentBeltLabelEs : summary.currentBeltLabelEn,
        }),
      };
    }),
  );

  // "Próximos" list: `atBeltCount`/`remainingAttendance` are already both
  // on `PromotionCandidate` (approaching status always has a positive
  // remaining count) — no extra query needed here, unlike the queue above.
  const upcomingRows = approachingStudents.map((candidate: PromotionCandidate) => ({
    candidate,
    detail: t("panel.promotionQueue.upcomingRow", {
      current: candidate.atBeltCount,
      target: candidate.atBeltCount + (candidate.remainingAttendance ?? 0),
      remaining: candidate.remainingAttendance ?? 0,
    }),
  }));

  // §4.1 Task 4: "Alumnos por contactar" — every role, no gate (see
  // contact-list.ts's own doc comment on why this is NOT a lowered-threshold
  // `getRetentionList`).
  const contactList = await listStudentsToContact(context);

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — the wizard's own acceptance
  // criteria named this reminder card as not yet built. Shown to
  // ADMIN/DIRECTOR (reusing `canViewOverduePayments`'s own role check, not a
  // new one) only while the organization still has no logo uploaded and
  // hasn't dismissed it before — a logo is the most visible sign branding is
  // actually finished, and dismissal never needs to un-set on a later
  // branding edit (see this field's own schema doc comment).
  let showBrandingReminder = false;
  if (canViewOverduePayments) {
    const [organization, branding] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: context.organizationId },
        select: { brandingReminderDismissedAt: true },
      }),
      getOrganizationBranding(context),
    ]);
    showBrandingReminder = !organization?.brandingReminderDismissedAt && !branding.logoUrl;
  }

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{eyebrowDate}</p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("panel.sub", {
            academy: academyLabel,
            attendance: weeklyAttendanceCount,
            promotions: promotionQueue.length,
          })}
        </p>
      </header>

      {showBrandingReminder && <BrandingReminderCard locale={locale} />}

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t("pendingApprovals", { count: pendingCount })}</span>
        <a href={`/${locale}/students?status=PENDING`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          {t("pendingApprovalsLink")}
        </a>
        {canViewOverduePayments && (
          <a href={`/${locale}/dashboard/analytics`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            {t("analyticsLink")}
          </a>
        )}
      </div>

      {/* §4.1 Task 1: stat row of 4 (3 for INSTRUCTOR, who never sees the
          overdue-payments tile — see canViewOverduePayments's doc comment),
          plus 2 more for Phase 3c-iii's kids/adults breakdown. */}
      <StatRow columns={canViewOverduePayments ? 6 : 5}>
        <StatTile label={t("panel.stats.activeStudents.label")} value={activeStudentCount} note={academyLabel} />
        <StatTile label={t("panel.stats.activeKids.label")} value={activeKidsCount} note={academyLabel} />
        <StatTile label={t("panel.stats.activeAdults.label")} value={activeAdultsCount} note={academyLabel} />
        <StatTile
          label={t("panel.stats.weeklyAttendance.label")}
          value={weeklyAttendanceCount}
          delta={attendanceDelta}
        />
        <StatTile
          label={t("panel.stats.readyToGrade.label")}
          value={promotionQueue.length}
          flag="accent"
          note={readyNote || undefined}
        />
        {canViewOverduePayments && (
          <StatTile
            label={t("panel.stats.overdue.label")}
            value={overdueStudents.length}
            flag="bad"
            note={overdueNote || undefined}
          />
        )}
      </StatRow>

      {/* §4.1 Task 2: weekly attendance trend + belt distribution. */}
      {canViewOverduePayments && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>{t("panel.weeklyChart.heading")}</CardTitle>
              <CardAction className="text-xs text-muted-foreground">
                {t("panel.weeklyChart.caption", { weeks: WEEKLY_CHART_WINDOW_WEEKS })}
              </CardAction>
            </CardHeader>
            <CardContent>
              <WeeklyAttendanceChart
                data={weeklyTrend}
                emptyMessage={t("panel.weeklyChart.empty")}
                countLabel={t("panel.weeklyChart.countLabel")}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>{t("panel.beltDistribution.heading")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {beltDistributionHasData ? (
                <BarList items={beltBarItems} />
              ) : (
                <EmptyState message={t("panel.beltDistribution.empty")} />
              )}
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                {t("panel.beltDistribution.caption", {
                  white: stripeThresholdByBelt.get("WHITE") ?? "—",
                  blue: stripeThresholdByBelt.get("BLUE") ?? "—",
                  purple: stripeThresholdByBelt.get("PURPLE") ?? "—",
                  brown: stripeThresholdByBelt.get("BROWN") ?? "—",
                })}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Phase 8: attendance-by-class, directly below the weekly trend, full
          width, sharing its exact window — every staff role sees this (see
          getAttendanceByClass's own doc comment), unlike the trend above. */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("panel.attendanceByClass.heading")}</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {t("panel.weeklyChart.caption", { weeks: WEEKLY_CHART_WINDOW_WEEKS })}
          </CardAction>
        </CardHeader>
        <CardContent>
          <AttendanceByClassChart rows={attendanceByClass} emptyMessage={t("panel.attendanceByClass.empty")} />
        </CardContent>
      </Card>

      {/* §4.1 Task 3: franja heatmap + promotion queue/"Próximos". */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("panel.franjaHeatmap.heading")}</CardTitle>
            <CardAction className="text-xs text-muted-foreground">
              {t("panel.franjaHeatmap.caption", { weeks: FRANJA_WINDOW_WEEKS })}
            </CardAction>
          </CardHeader>
          <CardContent>
            {franjaHasData ? (
              <Heatmap rowLabels={franjaRowLabels} colLabels={franjaColLabels} cells={franjaCells} />
            ) : (
              <EmptyState message={t("panel.franjaHeatmap.empty")} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("promotionQueue.heading")}</CardTitle>
            <CardAction className="text-xs text-muted-foreground">
              {t("panel.promotionQueue.eligibleCount", { count: promotionQueue.length })}
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {promotionQueue.length === 0 ? (
              <EmptyState message={t("promotionQueue.empty")} />
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {queueRows.map(({ candidate, detail }) => (
                  <div key={candidate.studentId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <BeltBar belt={candidate.currentBeltVisual} stripes={candidate.currentStripes} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {candidate.firstName} {candidate.lastName}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{detail}</span>
                    </div>
                    {/* Server-side gate is the real enforcement
                        (confirmPromotion re-checks role + scope) — this only
                        avoids showing a control to a role that would just be
                        rejected, as defense in depth. */}
                    {canConfirmPromotion && (
                      <ConfirmPromotionButton
                        organizationId={context.organizationId}
                        studentId={candidate.studentId}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {upcomingRows.length > 0 && (
              <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
                  {t("panel.promotionQueue.upcomingHeading")}
                </p>
                {upcomingRows.map(({ candidate, detail }) => (
                  <div key={candidate.studentId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-muted-foreground">
                      {candidate.firstName} {candidate.lastName} ·{" "}
                      {locale === "es" ? candidate.currentBeltLabelEs : candidate.currentBeltLabelEn}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{detail}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* §4.1 Task 4: "Alumnos por contactar" — every role, no gate. */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("panel.contact.heading")}</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {t("panel.contact.caption", { days: CONTACT_THRESHOLD_DAYS })}
          </CardAction>
        </CardHeader>
        <CardContent>
          {contactList.length === 0 ? (
            <EmptyState message={t("panel.contact.empty", { days: CONTACT_THRESHOLD_DAYS })} />
          ) : (
            <DataTable>
              <DataTableHead>
                <DataTableHeaderRow>
                  <DataTableHeaderCell>{t("panel.contact.table.name")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("panel.contact.table.academy")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("panel.contact.table.phone")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("panel.contact.table.lastAttendance")}</DataTableHeaderCell>
                  <DataTableHeaderCell className="text-right">
                    {t("panel.contact.table.daysAbsent")}
                  </DataTableHeaderCell>
                  <DataTableHeaderCell>{t("panel.contact.table.payment")}</DataTableHeaderCell>
                  <DataTableHeaderCell>
                    <span className="sr-only">{t("panel.contact.table.actions")}</span>
                  </DataTableHeaderCell>
                </DataTableHeaderRow>
              </DataTableHead>
              <DataTableBody>
                {contactList.map((entry) => {
                  const waLink = buildWhatsAppLink(entry.phone, t("panel.contact.contactMessage", { name: entry.firstName }));
                  return (
                    <DataTableRow key={entry.studentId}>
                      <DataTableCell>
                        <div className="font-medium">
                          {entry.firstName} {entry.lastName}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {locale === "es" ? entry.currentBeltLabelEs : entry.currentBeltLabelEn} · {entry.atBeltCount}
                          {entry.nextStripeAt != null ? ` / ${entry.nextStripeAt}` : ""}
                        </div>
                      </DataTableCell>
                      <DataTableCell>{entry.homeAcademyName}</DataTableCell>
                      <DataTableCell className="text-muted-foreground">{entry.phone}</DataTableCell>
                      <DataTableCell>
                        {entry.lastAttendanceAt
                          ? formatTimestampInAcademyZone(entry.lastAttendanceAt, locale)
                          : t("panel.contact.neverAttended")}
                      </DataTableCell>
                      <DataTableCell
                        className={cn("text-right font-medium tabular-nums", daysAbsentSeverityClass(entry.daysAbsent))}
                      >
                        {entry.daysAbsent ?? "—"}
                      </DataTableCell>
                      <DataTableCell>
                        <Pill variant={paymentStatusPillVariant(entry.paymentStatus)}>
                          {paymentStatusLabel(entry.paymentStatus, tPaymentStatus)}
                        </Pill>
                      </DataTableCell>
                      <DataTableCell>
                        {waLink ? (
                          <a
                            href={waLink}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                          >
                            {t("panel.contact.whatsappButton")}
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("panel.contact.whatsappUnavailable")}</span>
                        )}
                      </DataTableCell>
                    </DataTableRow>
                  );
                })}
              </DataTableBody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      {/* /admin/kiosk-tokens and /admin/schedule were both fully built but
          reachable only by typing the URL. Shown to ADMIN sessions only,
          matching each page's own `requireStaffSession(["ADMIN"])` gate —
          this is navigation convenience, not the access control. */}
      {context.organizationRole === "ADMIN" && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("adminSection")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <a
              href={`/${locale}/admin/kiosk-tokens`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              {t("adminKioskTokensLink")}
            </a>
            <a href={`/${locale}/admin/schedule`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              {t("adminScheduleLink")}
            </a>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
