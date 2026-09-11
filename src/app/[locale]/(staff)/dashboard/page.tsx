import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { academyScopeWhere, requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import { Card, CardContent } from "@/components/ui/card";
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
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { nextBelt } from "@/lib/students/eligibility";
import { getWeeklyAttendanceTrend } from "@/lib/analytics/retention";
import { getBeltDistribution } from "@/lib/analytics/progression";
import type { AnalyticsFilters } from "@/lib/analytics/filters";
import { getFranjaHeatmap, FRANJA_DAY_ORDER, TIME_BAND_ORDER } from "@/lib/analytics/franja-heatmap";
import { listStudentsToContact, CONTACT_THRESHOLD_DAYS, type ContactPaymentStatus } from "@/lib/students/contact-list";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { ConfirmPromotionButton } from "./confirm-promotion-button";
import { WeeklyAttendanceChart } from "./weekly-attendance-chart";
import type { Belt, Prisma } from "@/generated/prisma/client";
import { cn } from "cn";

// Same reasoning as the roster page: the pending-approvals count is staff
// data that can change without a redeploy, so this page must never be
// statically frozen at build time.
export const dynamic = "force-dynamic";

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

/**
 * `wa.me` deep link with a pre-filled message (REDESIGN_BRIEF.md §4.1 Task
 * 4). Strips everything but digits, then prepends Costa Rica's country code
 * only if it isn't already there — every stored/seeded phone in this app is a
 * plain 8-digit local number with no country code (see
 * `tests/integration/students-roster.test.ts`'s fixtures), so this always
 * ends up prefixing 506 in practice, but the check stays explicit rather than
 * assuming the stored shape never changes.
 */
function buildWhatsAppLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, "");
  const withCountryCode = digits.startsWith("506") ? digits : `506${digits}`;
  return `https://wa.me/${withCountryCode}?text=${encodeURIComponent(message)}`;
}

export default async function DashboardPage() {
  const staffSession = await requireStaffSession();
  const t = await getTranslations("dashboard");
  const tBelt = await getTranslations("belt");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const tBand = await getTranslations("dashboard.panel.franjaHeatmap.bands");
  const tDay = await getTranslations("dayOfWeek");
  const locale = await getLocale();
  const now = DateTime.now().setZone(ZONE);

  // academyScopeWhere(session) returns a fragment keyed `academyId`, but
  // Student's tenancy column is `homeAcademyId` — spreading the fragment
  // directly would throw a Prisma validation error for any non-ADMIN
  // session (confirmed while manually verifying this task). Translate it
  // the same way src/app/[locale]/(staff)/students/actions.ts's listStudents does,
  // so a DIRECTOR/INSTRUCTOR only ever sees the pending count for their own
  // academy/academies — never a global count — and ADMIN (whose scope
  // fragment is `{}`) sees every pending student.
  const scope = academyScopeWhere(staffSession);
  const pendingCount = await prisma.student.count({
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
  // `staffSession.role`, so this is belt-and-suspenders, not the only check.
  // The same boolean also gates §4.1 Task 2's weekly-attendance chart and
  // belt-distribution panel below — both back onto `getWeeklyAttendanceTrend`
  // / `getBeltDistribution` (src/lib/analytics/{retention,progression}.ts),
  // which are themselves self-enforced ADMIN/DIRECTOR-only, so INSTRUCTOR
  // never sees that whole section, matching "keep the existing role-gating
  // exactly as it is today" for this dashboard.
  const canViewOverduePayments = staffSession.role === "ADMIN" || staffSession.role === "DIRECTOR";

  // Both promotion queries scope by academyScopeWhere internally (see
  // promotion-queue.ts) the same way pendingCount does above — a
  // DIRECTOR/INSTRUCTOR only ever sees their own academy/academies here too.
  const [promotionQueue, approachingStudents, overdueStudents] = await Promise.all([
    listPromotionQueue(staffSession),
    listApproachingStudents(staffSession),
    canViewOverduePayments ? listOverdueStudents(staffSession) : Promise.resolve<OverdueStudent[]>([]),
  ]);

  // Confirming a promotion is ADMIN/DIRECTOR only (spec §3 excludes
  // INSTRUCTOR from promotions, same restriction confirmPromotion enforces
  // server-side) — mirrors student detail page's `canEdit` gate. INSTRUCTOR
  // sessions still see both lists in full, just without the button.
  const canConfirmPromotion = staffSession.role === "ADMIN" || staffSession.role === "DIRECTOR";

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
      academyScopeWhere(staffSession),
      { type: "CHECKIN" },
      { occurredAt: { gte: from.toJSDate(), lte: to.toJSDate() } },
    ],
  });

  const [activeStudentCount, weeklyAttendanceCount, previousWeekAttendanceCount, academyRows] = await Promise.all([
    prisma.student.count({
      where: {
        status: "ACTIVE",
        ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
      },
    }),
    prisma.attendanceRecord.count({ where: weeklyAttendanceConditions(currentWeekStart, currentWeekEnd) }),
    prisma.attendanceRecord.count({ where: weeklyAttendanceConditions(previousWeekStart, previousWeekEnd) }),
    prisma.academy.findMany({
      where: scope.academyId ? { id: { in: scope.academyId.in } } : {},
      orderBy: { name: "asc" },
      select: { name: true },
    }),
  ]);

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
  let weeklyTrend: Array<{ weekStart: string; count: number }> = [];
  let beltDistribution: Array<{ belt: Belt; count: number }> = [];
  let stripeThresholdByBelt = new Map<Belt, number>();
  if (canViewOverduePayments) {
    const eightWeekFilters: AnalyticsFilters = {
      from: now.minus({ weeks: 8 }).startOf("day"),
      to: now.endOf("day"),
      academyId: null,
    };
    const [trend, distribution, stripeThresholdRows] = await Promise.all([
      getWeeklyAttendanceTrend(staffSession, eightWeekFilters),
      getBeltDistribution(staffSession, eightWeekFilters),
      // Real thresholds (30/65/75/85 in the seeded default data), never
      // hardcoded — the belt-distribution caption states whatever
      // `BeltRequirement` actually says. Global (academyId: null) rows only:
      // this caption states one general rule, not every academy's override.
      prisma.beltRequirement.findMany({
        where: { academyId: null, belt: { in: ["WHITE", "BLUE", "PURPLE", "BROWN"] } },
        select: { belt: true, attendancesPerStripe: true },
      }),
    ]);
    weeklyTrend = trend;
    beltDistribution = distribution;
    stripeThresholdByBelt = new Map(stripeThresholdRows.map((row) => [row.belt, row.attendancesPerStripe]));
  }

  const beltDistributionHasData = beltDistribution.some((row) => row.count > 0);
  const beltBarItems: BarListItem[] = beltDistribution.map((row) => ({
    key: row.belt,
    label: tBelt(row.belt),
    value: row.count,
    colorClassName: BELT_BAR_COLOR_CLASS[row.belt],
  }));

  // §4.1 Task 3a: "Asistencia promedio por franja" — every role, no gate.
  const franjaGrid = await getFranjaHeatmap(staffSession);
  const franjaRowLabels = TIME_BAND_ORDER.map((band) => tBand(band));
  const franjaColLabels = FRANJA_DAY_ORDER.map((day) => tDay(day).slice(0, 3));
  const franjaCells: HeatmapCell[][] = TIME_BAND_ORDER.map((_, bandIndex) =>
    FRANJA_DAY_ORDER.map((_, dayIndex) => ({ value: franjaGrid[dayIndex][bandIndex].average })),
  );
  const franjaHasData = franjaCells.some((row) => row.some((cell) => cell.value !== null));

  // §4.1 Task 3b: "Cola de promociones" row text ("29 / 30 · 4.ª franja
  // blanca" / "63 / 65 · examen de morada"). `PromotionCandidate` alone
  // doesn't carry the threshold (Y) once a candidate has already crossed
  // it — `remainingToNextStripe` is clamped to 0 at that point — so this
  // reuses `getAtBeltSummary` (already built, already used internally by
  // `promotion-queue.ts`'s own classification) per candidate rather than a
  // second query; the list is always small (a handful of eligible students).
  const queueRows = await Promise.all(
    promotionQueue.map(async (candidate) => {
      const summary = await getAtBeltSummary(candidate.studentId);
      if (candidate.status === "exam-eligible") {
        const target = nextBelt(summary.currentBelt);
        return {
          candidate,
          detail: t("panel.promotionQueue.examRow", {
            current: summary.atBeltCount,
            target: summary.maxStripes * summary.attendancesPerStripe + summary.attendancesForExam,
            belt: target ? tBelt(target) : "",
          }),
        };
      }
      return {
        candidate,
        detail: t("panel.promotionQueue.stripeRow", {
          current: summary.atBeltCount,
          target: summary.nextStripeAt ?? summary.atBeltCount,
          ordinal: summary.currentStripes + 1,
          belt: tBelt(summary.currentBelt),
        }),
      };
    }),
  );

  // "Próximos" list: `atBeltCount`/`remainingToNextStripe` are already both
  // on `PromotionCandidate` (approaching status always has a positive
  // remaining count) — no extra query needed here, unlike the queue above.
  const upcomingRows = approachingStudents.map((candidate: PromotionCandidate) => ({
    candidate,
    detail: t("panel.promotionQueue.upcomingRow", {
      current: candidate.atBeltCount,
      target: candidate.atBeltCount + (candidate.remainingToNextStripe ?? 0),
      remaining: candidate.remainingToNextStripe ?? 0,
    }),
  }));

  // §4.1 Task 4: "Alumnos por contactar" — every role, no gate (see
  // contact-list.ts's own doc comment on why this is NOT a lowered-threshold
  // `getRetentionList`).
  const contactList = await listStudentsToContact(staffSession);

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
          overdue-payments tile — see canViewOverduePayments's doc comment). */}
      <StatRow columns={canViewOverduePayments ? 4 : 3}>
        <StatTile label={t("panel.stats.activeStudents.label")} value={activeStudentCount} note={academyLabel} />
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
            <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 pb-3">
              <h2 className="font-heading text-base font-medium">{t("panel.weeklyChart.heading")}</h2>
              <span className="text-xs text-muted-foreground">{t("panel.weeklyChart.caption")}</span>
            </div>
            <CardContent className="pt-4">
              <WeeklyAttendanceChart
                data={weeklyTrend}
                emptyMessage={t("panel.weeklyChart.empty")}
                countLabel={t("panel.weeklyChart.countLabel")}
              />
            </CardContent>
          </Card>

          <Card>
            <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 pb-3">
              <h2 className="font-heading text-base font-medium">{t("panel.beltDistribution.heading")}</h2>
            </div>
            <CardContent className="flex flex-col gap-4 pt-4">
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

      {/* §4.1 Task 3: franja heatmap + promotion queue/"Próximos". */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
        <Card>
          <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 pb-3">
            <h2 className="font-heading text-base font-medium">{t("panel.franjaHeatmap.heading")}</h2>
            <span className="text-xs text-muted-foreground">{t("panel.franjaHeatmap.caption")}</span>
          </div>
          <CardContent className="pt-4">
            {franjaHasData ? (
              <Heatmap rowLabels={franjaRowLabels} colLabels={franjaColLabels} cells={franjaCells} />
            ) : (
              <EmptyState message={t("panel.franjaHeatmap.empty")} />
            )}
          </CardContent>
        </Card>

        <Card>
          <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 pb-3">
            <h2 className="font-heading text-base font-medium">{t("promotionQueue.heading")}</h2>
            <span className="text-xs text-muted-foreground">
              {t("panel.promotionQueue.eligibleCount", { count: promotionQueue.length })}
            </span>
          </div>
          <CardContent className="flex flex-col gap-3 pt-4">
            {promotionQueue.length === 0 ? (
              <EmptyState message={t("promotionQueue.empty")} />
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {queueRows.map(({ candidate, detail }) => (
                  <div key={candidate.studentId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <BeltBar belt={candidate.currentBelt} stripes={candidate.currentStripes} />
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
                    {canConfirmPromotion && <ConfirmPromotionButton studentId={candidate.studentId} />}
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
                      {candidate.firstName} {candidate.lastName} · {tBelt(candidate.currentBelt)}
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
        <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 pb-3">
          <h2 className="font-heading text-base font-medium">{t("panel.contact.heading")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("panel.contact.caption", { days: CONTACT_THRESHOLD_DAYS })}
          </span>
        </div>
        <CardContent className="pt-4">
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
                          {tBelt(entry.currentBelt)} · {entry.atBeltCount}
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
                        <a
                          href={waLink}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                        >
                          {t("panel.contact.whatsappButton")}
                        </a>
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
      {staffSession.role === "ADMIN" && (
        <Card>
          <div className="border-b border-border px-4 pb-3">
            <h2 className="font-heading text-base font-medium">{t("adminSection")}</h2>
          </div>
          <CardContent className="flex flex-wrap gap-2 pt-4">
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
