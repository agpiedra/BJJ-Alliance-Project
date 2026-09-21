import { DateTime } from "luxon";
import { cn } from "cn";
import { getTranslations } from "next-intl/server";
import { requirePortalContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";
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
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { getAttendanceHistory } from "@/lib/students/attendance-history";
import { getOwnPromotionHistory } from "./get-promotion-history";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { getCurrentPaymentPeriod, currentCrDateParts } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { ContactPaymentStatus } from "@/lib/students/contact-list";
import { SelfCheckInButton } from "./self-check-in-button";
import { PortalTopBar } from "./portal-top-bar";
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

/**
 * Hero progress bar's current/target pair — the exact same derivation as the
 * roster page's own page-local `resolveProgressTarget` (`(staff)/students/
 * page.tsx`), duplicated rather than imported (that function isn't exported,
 * and both are thin presentation-only reads of `AtBeltSummary`'s already-
 * computed fields — Rule 8 forbids reimplementing the belt math itself, not
 * this kind of view-level pairing, which is why the roster page doesn't put
 * it in `src/lib/students/*` either). `null` means no further computable
 * progress (e.g. a maxed-out belt with no exam threshold configured).
 */
function resolveProgressTarget(summary: AtBeltSummary): { current: number; target: number } | null {
  if (summary.nextTarget === "STRIPE") {
    return { current: summary.atBeltCount, target: (summary.currentStripes + 1) * summary.attendancesPerStripe };
  }
  if (summary.nextTarget === "BELT" && summary.attendancesForExam > 0) {
    return {
      current: summary.atBeltCount,
      target: summary.maxStripes * summary.attendancesPerStripe + summary.attendancesForExam,
    };
  }
  return null;
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
  const [student, summary, attendanceHistory, promotionHistory, currentPaymentPeriod] = await Promise.all([
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
    getAttendanceHistory(studentId, context.organizationId),
    getOwnPromotionHistory(studentId, context.organizationId),
    // Scoped to studentId exactly like every other portal query above — no
    // route param, so there's no way to see another student's payment status
    // (spec §4.2 shows this to the student only, read-only, no recording UI).
    getCurrentPaymentPeriod(studentId, context.organizationId),
  ]);
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
  const tStudents = await getTranslations("students");
  const tAttendanceType = await getTranslations("portal.attendanceHistory.type");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const tAdminSchedule = await getTranslations("adminSchedule");
  const tClassType = await getTranslations("classType");

  const progressTarget = resolveProgressTarget(summary);
  const legend: WeekCalendarLegendItem[] = CLASS_TYPE_LEGEND_ORDER.map((type) => ({
    colorClassName: CLASS_TYPE_COLOR_CLASS[type],
    label: tClassType(type),
  }));

  return (
    <BrandingScope branding={branding}>
      <PortalTopBar
        locale={locale}
        firstName={student.firstName}
        lastName={student.lastName}
        logo={{
          logoUrl: branding.logoUrl,
          initials: branding.initials,
          initialsBackground: branding.sidebar.background,
          initialsForeground: branding.sidebar.foreground,
          displayName: branding.displayName,
        }}
      />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-4">
        <h1 className="text-2xl font-bold">{t("greeting", { name: student.firstName })}</h1>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("progress.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <BeltBar belt={summary.currentBeltVisual} stripes={summary.currentStripes} />
              <span className="text-sm font-medium">
                {locale === "es" ? summary.currentBeltLabelEs : summary.currentBeltLabelEn} ·{" "}
                {tStudents("beltStripes", { count: summary.currentStripes })}
              </span>
              {progressTarget && (
                <ProgressToNextGrade
                  current={progressTarget.current}
                  target={progressTarget.target}
                  className="w-full max-w-[220px]"
                />
              )}
            </div>

            <div className="flex flex-col gap-1 text-sm">
              <p>{t("progress.atBeltCount", { count: summary.atBeltCount })}</p>

              {summary.remainingAttendance !== null && (
                <p className="text-muted-foreground">
                  {t("progress.remainingToNextStripe", { count: summary.remainingAttendance })}
                </p>
              )}

              {summary.remainingAttendance === null && summary.nextTarget === "BELT" && summary.isEligible && (
                <p className="font-medium">{t("progress.examEligible")}</p>
              )}

              <p className="text-muted-foreground">
                {t("progress.lifetimeCount", { count: summary.lifetimeCount })}
              </p>
            </div>
          </CardContent>
        </Card>

        <SelfCheckInButton organizationId={context.organizationId} />

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("attendanceHistory.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {attendanceHistory.length === 0 ? (
              <EmptyState message={t("attendanceHistory.empty")} />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {attendanceHistory.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {formatTimestampInAcademyZone(entry.date, locale)}
                      </span>
                      <span className={cn("tabular-nums", entry.delta < 0 ? "text-destructive" : "text-foreground")}>
                        {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                      </span>
                    </div>
                    <span className="text-muted-foreground">
                      {entry.className ?? tAttendanceType(entry.type)}
                    </span>
                    {entry.reason && (
                      <span className="text-muted-foreground italic">{entry.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

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
                      <span className="font-medium">
                        {formatTimestampInAcademyZone(promotion.awardedAt, locale)}
                      </span>
                      <Badge variant="outline">
                        {locale === "es" ? promotion.fromBeltLabelEs : promotion.fromBeltLabelEn} {promotion.fromStripes}{" "}
                        → {locale === "es" ? promotion.toBeltLabelEs : promotion.toBeltLabelEn} {promotion.toStripes}
                      </Badge>
                    </div>
                    {promotion.notes && (
                      <span className="text-muted-foreground italic">{promotion.notes}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("paymentStatus.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{currentPaymentPeriod?.planName ?? "—"}</span>
              <Pill variant={paymentPillVariant(paymentStatus)}>
                {paymentStatusLabel(paymentStatus, t, tPaymentStatus)}
              </Pill>
            </div>
            {overdue && (
              <p className="text-sm text-muted-foreground">{t("paymentStatus.overdueNotice")}</p>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>{t("schedule.heading")}</CardTitle>
            <CardDescription>
              {t("schedule.description", { academyName: student.homeAcademy.name, count: activeSessionCount })}
            </CardDescription>
          </CardHeader>
          {sessions.length === 0 ? (
            <CardContent className="pt-4">
              <EmptyState message={tAdminSchedule("empty")} />
            </CardContent>
          ) : (
            <WeekCalendar
              days={calendarDays}
              blocks={calendarBlocks}
              legend={legend}
              legendNote={sundayHasClasses ? undefined : tAdminSchedule("calendar.sundayNote")}
            />
          )}
        </Card>
      </main>
    </BrandingScope>
  );
}
