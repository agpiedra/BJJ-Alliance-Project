import { DateTime } from "luxon";
import { getTranslations } from "next-intl/server";
import { requirePortalContext } from "@/lib/tenant/context";
import { accessFromContext } from "@/lib/auth/derive-access";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Pill } from "@/components/ui/pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  WeekCalendar,
  type WeekCalendarBlock,
  type WeekCalendarDay,
  type WeekCalendarLegendItem,
} from "@/components/ui/week-calendar";
import { rowFor } from "@/components/ui/week-calendar-grid";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { buildProgressView } from "@/lib/promotion/progress-view";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { getAttendanceHistoryPage, getAttendanceTotals } from "@/lib/students/attendance-history";
import { ATTENDANCE_PAGE_SIZE, toAttendanceRow } from "@/lib/portal/attendance-rows";
import { listTodaysClasses } from "@/lib/portal/todays-classes";
import { getOwnPromotionHistory } from "./get-promotion-history";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { getCurrentPaymentPeriod, currentCrDateParts } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { ContactPaymentStatus } from "@/lib/students/contact-list";
import { TodaysClassesCard } from "./todays-classes-card";
import { AttendanceHistorySection } from "./attendance-history-section";
import { PortalTopBar } from "./portal-top-bar";
import { PortalTabs } from "./portal-tabs";
import { ProgressCard } from "./progress-card";
import { RecentAttendanceCard } from "./recent-attendance-card";
import { ScheduleDayList } from "./schedule-day-list";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { BrandingScope } from "@/components/branding/branding-scope";
import { listClassSessions } from "../(staff)/admin/schedule/queries";
import {
  SUNDAY_FIRST_DAYS,
  CLASS_TYPE_COLOR_CLASS,
  CLASS_TYPE_LEGEND_ORDER,
  startOfSundayWeek,
  addMinutesToClockTime,
} from "../(staff)/admin/schedule/calendar-helpers";
import { DayOfWeek } from "@/generated/prisma/browser";
import { ZONE } from "@/lib/scheduling/zone";

// A student's own belt/status could change without a redeploy (staff can
// promote them, adjust attendance, or flip their status any time) — never
// statically cached, same reasoning as the staff student-detail page and the
// kiosk page.
export const dynamic = "force-dynamic";

/** Strips the trailing "." some locales (es-CR) put on `{weekday:"short"}`
 * and capitalizes the first letter — copy of the admin schedule page's own
 * page-local helper (`(staff)/admin/schedule/page.tsx`), not shared: it's
 * cosmetic `Intl` formatting over a real `Date`, not translated copy, and
 * both call sites are page-local by the same convention. */
function shortWeekdayLabel(date: Date, locale: string): string {
  const raw = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { weekday: "short" }).format(date);
  const trimmed = raw.replace(/\.$/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Same precedence and variant mapping as the roster page's own page-local
// `paymentPillVariant`/`paymentStatusLabel` (`(staff)/students/page.tsx`):
// overdue takes priority over a recorded PENDING period, and only semantic
// colors are used (never gold/"accent" for "good" — Rule 2).
function paymentPillVariant(status: ContactPaymentStatus): "ok" | "warn" | "bad" | "accent" | "plain" {
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

function paymentStatusLabel(
  status: ContactPaymentStatus,
  t: (key: string) => string,
  tPaymentStatus: (key: string) => string,
): string {
  if (status === "OVERDUE") return t("paymentStatus.overdue");
  if (status === "NOT_RECORDED") return t("paymentStatus.notRecorded");
  return tPaymentStatus(status);
}

export default async function StudentPortalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // Anyone with a linked, ACTIVE student record — a coach who also trains
  // included (see requirePortalContext). `studentId` is that record, re-derived
  // from the database on every request.
  const { context, studentId } = await requirePortalContext();
  const { locale } = await params;
  const branding = await getOrganizationBranding(context);

  // Safe with no additional scope check: `studentId` came from the tenant
  // context itself (re-verified against the DB on every call), never from a
  // route param an attacker could substitute another student's id into —
  // unlike `students/[id]/page.tsx`, which must scope-check a caller-supplied
  // id before trusting it.
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const [student, summary, historyPage, attendanceTotals, promotionHistory, currentPaymentPeriod] = await Promise.all([
    prisma.student.findUniqueOrThrow({
      where: { id: studentId, organizationId: context.organizationId },
      select: {
        firstName: true,
        lastName: true,
        status: true,
        homeAcademy: { select: { id: true, name: true } },
      },
    }),
    getAtBeltSummary(studentId, context.organizationId, configByTrack),
    // The first page of the student's history, and the defined total over the WHOLE ledger (not the page length).
    getAttendanceHistoryPage(studentId, context.organizationId, { limit: ATTENDANCE_PAGE_SIZE }),
    getAttendanceTotals(studentId, context.organizationId),
    getOwnPromotionHistory(studentId, context.organizationId),
    // Scoped to studentId exactly like every other portal query above — no
    // route param, so there's no way to see another student's payment status
    // (spec §4.2 shows this to the student only, read-only, no recording UI).
    getCurrentPaymentPeriod(studentId, context.organizationId),
  ]);
  // Today's classes for the student's own academy (Costa Rica day and boundaries), each with its honest state.
  const todays = await listTodaysClasses({ context, academyId: student.homeAcademy.id, studentId });
  const overdue = isOverdue(currentPaymentPeriod, currentCrDateParts());
  const paymentStatus: ContactPaymentStatus = overdue
    ? "OVERDUE"
    : currentPaymentPeriod
      ? currentPaymentPeriod.status
      : "NOT_RECORDED";

  // Phase 8's read-only week calendar: this student's OWN home academy,
  // current week only — no navigation, no view switcher, no click-to-detail,
  // no instructor filter (the app has no such concept anywhere, per an
  // earlier phase's ruling). `listClassSessions` is the same plain,
  // non-"use server" function the ADMIN schedule page calls — see that
  // function's own doc comment (`(staff)/admin/schedule/queries.ts`) for why
  // an organizationId + academyId filter is required (revision 23). Row-
  // placement/overlap-layout/Sunday-first ordering are the exact same shared
  // helpers the admin calendar view uses
  // (`(staff)/admin/schedule/calendar-helpers.ts`) — nothing there needed
  // changing to be reusable here.
  const sessions = await listClassSessions(context.organizationId, student.homeAcademy.id);
  const now = DateTime.now().setZone(ZONE);
  const weekStart = startOfSundayWeek(now);
  const weekDates = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
  const hasClassesByDay = new Map(
    SUNDAY_FIRST_DAYS.map((day) => [day, sessions.some((s) => s.dayOfWeek === day)]),
  );
  const calendarDays: WeekCalendarDay[] = weekDates.map((date, index) => {
    const dayOfWeek = SUNDAY_FIRST_DAYS[index];
    return {
      key: dayOfWeek,
      label: shortWeekdayLabel(date.toJSDate(), locale),
      dateNumber: date.day,
      isToday: date.hasSame(now, "day"),
      isOff: !hasClassesByDay.get(dayOfWeek),
    };
  });
  const calendarBlocks: WeekCalendarBlock[] = sessions.map((s) => {
    const [hour, minute] = s.startTime.split(":").map(Number);
    const end = addMinutesToClockTime(s.startTime, s.durationMinutes);
    return {
      id: s.id,
      dayKey: s.dayOfWeek,
      title: s.name,
      timeLabel: `${s.startTime} – ${end.label}`,
      startRow: rowFor(hour, minute),
      endRow: rowFor(end.hour, end.minute),
      colorClassName: CLASS_TYPE_COLOR_CLASS[s.type],
      dimmed: !s.active,
    };
  });
  const sundayHasClasses = hasClassesByDay.get(DayOfWeek.SUNDAY) ?? false;
  const activeSessionCount = sessions.filter((s) => s.active).length;

  const t = await getTranslations("portal");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const tAdminSchedule = await getTranslations("adminSchedule");
  const tClassType = await getTranslations("classType");

  // One display shaping for every surface (buildProgressView): an eligible student shows a full bar with the
  // count capped at the target - never 42 / 30 - and a time-based degree shows a due date, not a fraction.
  const progressView = buildProgressView(summary);
  const dueDateFormatted = formatTimestampInAcademyZone(summary.dueDate, locale);
  const legend: WeekCalendarLegendItem[] = CLASS_TYPE_LEGEND_ORDER.map((type) => ({
    colorClassName: CLASS_TYPE_COLOR_CLASS[type],
    label: tClassType(type),
  }));
  const historyRows = historyPage.entries.map((entry) => toAttendanceRow(entry, locale));

  const checkInCard = (
    <TodaysClassesCard
      organizationId={context.organizationId}
      classes={todays.classes}
      nextChangeAt={todays.nextChangeAt}
      serverNow={todays.serverNow}
    />
  );
  const progressCard = <ProgressCard locale={locale} summary={summary} view={progressView} dueDateLabel={dueDateFormatted} />;

  const paymentCard = (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("paymentStatus.heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{currentPaymentPeriod?.planName ?? "—"}</span>
          <Pill variant={paymentPillVariant(paymentStatus)}>{paymentStatusLabel(paymentStatus, t, tPaymentStatus)}</Pill>
        </div>
        {overdue && <p className="text-sm text-muted-foreground">{t("paymentStatus.overdueNotice")}</p>}
      </CardContent>
    </Card>
  );

  const promotionCard = (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("promotionHistory.heading")}</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {promotionHistory.length === 0 ? (
          <EmptyState message={t("promotionHistory.empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {promotionHistory.map((promotion) => (
              <li key={promotion.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{formatTimestampInAcademyZone(promotion.awardedAt, locale)}</span>
                  <Badge variant="outline">
                    {locale === "es" ? promotion.fromBeltLabelEs : promotion.fromBeltLabelEn} {promotion.fromStripes} →{" "}
                    {locale === "es" ? promotion.toBeltLabelEs : promotion.toBeltLabelEn} {promotion.toStripes}
                  </Badge>
                </div>
                {promotion.notes && <span className="text-muted-foreground italic">{promotion.notes}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  // HOME. Two columns from `lg` (check-in and recent attendance left; progress, payment and promotions right). On narrower screens the two
  // column wrappers dissolve (`contents`) and `order` puts the cards in priority order: check-in, progress, recent attendance, payment,
  // promotion history. Progress comes second on purpose: it is what a student looks for right after checking in.
  const home = (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
      <div className="contents lg:flex lg:flex-col lg:gap-4">
        <div className="order-1">{checkInCard}</div>
        <div className="order-3">
          <RecentAttendanceCard rows={historyRows} />
        </div>
      </div>
      <div className="contents lg:flex lg:flex-col lg:gap-4">
        <div className="order-2">{progressCard}</div>
        <div className="order-4">{paymentCard}</div>
        <div className="order-5">{promotionCard}</div>
      </div>
    </div>
  );

  // ATTENDANCE: the full history (defined total, older entries on demand). A new attendance changes the key, so the list restarts from the
  // fresh first page (no gap under older pages). Progress sits beside it on desktop as context.
  const attendance = (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
      <AttendanceHistorySection
        key={`${attendanceTotals.entryCount}-${historyPage.entries[0]?.id ?? "none"}`}
        organizationId={context.organizationId}
        initialRows={historyRows}
        initialCursor={historyPage.nextCursor}
        totals={attendanceTotals}
        creditedClasses={summary.creditedClasses}
      />
      <ProgressCard locale={locale} summary={summary} view={progressView} dueDateLabel={dueDateFormatted} />
    </div>
  );

  // SCHEDULE: the seven-day calendar from `md`; a day-by-day list on phones (same data, same colours).
  const schedule = (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>{t("schedule.heading")}</CardTitle>
        <CardDescription>{t("schedule.description", { academyName: student.homeAcademy.name, count: activeSessionCount })}</CardDescription>
      </CardHeader>
      {sessions.length === 0 ? (
        <CardContent className="pt-4">
          <EmptyState message={tAdminSchedule("empty")} />
        </CardContent>
      ) : (
        <>
          <div className="hidden md:block">
            <WeekCalendar days={calendarDays} blocks={calendarBlocks} legend={legend} legendNote={sundayHasClasses ? undefined : tAdminSchedule("calendar.sundayNote")} />
          </div>
          <ScheduleDayList days={calendarDays} blocks={calendarBlocks} sundayHasClasses={sundayHasClasses} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-4 text-xs text-muted-foreground md:hidden">
            {legend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`inline-block size-3 rounded-sm ${item.colorClassName}`} />
                {item.label}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );

  return (
    <BrandingScope branding={branding}>
      <PortalTopBar
        locale={locale}
        firstName={student.firstName}
        lastName={student.lastName}
        hasStaff={accessFromContext(context).staff}
        logo={{
          logoUrl: branding.logoUrl,
          initials: branding.initials,
          initialsBackground: branding.sidebar.background,
          initialsForeground: branding.sidebar.foreground,
          displayName: branding.displayName,
        }}
      />
      <main className="mx-auto flex w-full max-w-[1120px] flex-col px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
        <h1 className="text-2xl font-bold">{t("greeting", { name: student.firstName })}</h1>
        <p className="mb-4 text-sm text-muted-foreground">{student.homeAcademy.name}</p>
        <PortalTabs
          listLabel={t("nav.label")}
          labels={{ home: t("nav.home"), attendance: t("nav.attendance"), schedule: t("nav.schedule") }}
          panels={{ home, attendance, schedule }}
        />
      </main>
    </BrandingScope>
  );
}
