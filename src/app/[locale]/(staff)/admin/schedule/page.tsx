import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterBarSelect } from "@/components/ui/filter-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import type { WeekCalendarDay, WeekCalendarLegendItem } from "@/components/ui/week-calendar";
import { listClassSessions } from "./queries";
import { CreateClassSessionForm } from "./create-class-session-form";
import { EditClassSessionForm } from "./edit-class-session-form";
import { DeactivateClassSessionButton } from "./deactivate-class-session-button";
import { ScheduleCalendarView } from "./schedule-calendar-view";
import {
  SUNDAY_FIRST_DAYS,
  DAY_OF_WEEK_BY_LUXON_WEEKDAY,
  CLASS_TYPE_COLOR_CLASS,
  CLASS_TYPE_LEGEND_ORDER,
  startOfSundayWeek,
} from "./calendar-helpers";
import { DayOfWeek } from "@/generated/prisma/browser";
import { ZONE } from "@/lib/scheduling/zone";
import { cn } from "cn";

// The academy list and its schedule are staff data that can change without a
// redeploy — never frozen at build time, same reasoning as the roster and
// kiosk-tokens pages.
export const dynamic = "force-dynamic";

type ScheduleView = "week" | "day" | "list";

type ScheduleSearchParams = {
  academyId?: string;
  view?: string;
  date?: string;
};

function parseView(value: string | undefined): ScheduleView {
  return value === "day" || value === "list" ? value : "week";
}

/** Strips the trailing "." some locales (es-CR) put on `{weekday:"short"}`
 * and capitalizes the first letter — cosmetic only, no translation needed
 * since this is locale-formatted from a real Date, not literal copy. */
function shortWeekdayLabel(date: Date, locale: string): string {
  const raw = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { weekday: "short" }).format(date);
  const trimmed = raw.replace(/\.$/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export default async function AdminSchedulePage({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  // ADMIN-only — schedule structure is academy policy (spec §5), not
  // something a DIRECTOR/INSTRUCTOR session can reach. The unscoped academy
  // list below (both Escazú and Escalante, regardless of assignment) is only
  // safe to read because this call already rejected any non-ADMIN session.
  await requireStaffSession(["ADMIN"]);
  const params = await searchParams;
  const locale = await getLocale();

  const academies = await prisma.academy.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const selectedAcademyId =
    params.academyId && academies.some((academy) => academy.id === params.academyId)
      ? params.academyId
      : academies[0]?.id;
  const selectedAcademy = academies.find((academy) => academy.id === selectedAcademyId);

  const sessions = selectedAcademyId ? await listClassSessions(selectedAcademyId) : [];

  const t = await getTranslations("adminSchedule");
  const tCal = await getTranslations("adminSchedule.calendar");
  const tDay = await getTranslations("dayOfWeek");
  const tType = await getTranslations("classType");

  const view = parseView(params.view);

  const now = DateTime.now().setZone(ZONE);
  const parsedAnchor = params.date ? DateTime.fromISO(params.date, { zone: ZONE }) : null;
  const anchor = parsedAnchor && parsedAnchor.isValid ? parsedAnchor.startOf("day") : now.startOf("day");

  function buildHref(nextView: ScheduleView, date: DateTime): string {
    const qs = new URLSearchParams();
    if (selectedAcademyId) qs.set("academyId", selectedAcademyId);
    qs.set("view", nextView);
    qs.set("date", date.toISODate() ?? "");
    return `?${qs.toString()}`;
  }

  const rangeFormatter = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    day: "numeric",
    month: "long",
  });
  const dayFormatter = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const legend: WeekCalendarLegendItem[] = CLASS_TYPE_LEGEND_ORDER.map((type) => ({
    colorClassName: CLASS_TYPE_COLOR_CLASS[type],
    label: tType(type),
  }));

  const viewLinks: { key: ScheduleView; label: string }[] = [
    { key: "week", label: tCal("week") },
    { key: "day", label: tCal("day") },
    { key: "list", label: tCal("list") },
  ];

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("eyebrow")}</p>
            <h1>{t("heading")}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label={tCal("viewLabel")}
              className="inline-flex overflow-hidden rounded-lg border border-border"
            >
              {viewLinks.map((link, index) => (
                <a
                  key={link.key}
                  href={buildHref(link.key, anchor)}
                  aria-pressed={view === link.key}
                  className={cn(
                    "px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:bg-brand-gold aria-pressed:font-semibold aria-pressed:text-brand-gold-foreground",
                    index > 0 && "border-l border-border",
                  )}
                >
                  {link.label}
                </a>
              ))}
            </div>

            {selectedAcademyId && (
              <Sheet>
                <SheetTrigger render={<Button type="button" variant="primary" size="sm" />}>
                  {tCal("newClass")}
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>{tCal("newClass")}</SheetTitle>
                    <SheetDescription>{tCal("newClassDescription")}</SheetDescription>
                  </SheetHeader>
                  <div className="px-4">
                    {/* Server-side gate is the real enforcement
                        (createClassSession itself re-checks the role) — this
                        only avoids showing the control on a page no other
                        role can reach anyway. */}
                    <CreateClassSessionForm academyId={selectedAcademyId} />
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {t("description", { academyName: selectedAcademy?.name ?? "", count: sessions.filter((s) => s.active).length })}
        </p>

        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={anchor.toISODate() ?? ""} />
          <label htmlFor="schedule-academy" className="sr-only">
            {t("academySelector")}
          </label>
          <FilterBarSelect id="schedule-academy" name="academyId" defaultValue={selectedAcademyId ?? ""}>
            {academies.map((academy) => (
              <option key={academy.id} value={academy.id}>
                {academy.name}
              </option>
            ))}
          </FilterBarSelect>
          <Button type="submit" variant="outline" size="sm">
            {t("selectorSubmit")}
          </Button>
        </form>
      </header>

      {(view === "week" || view === "day") && (
        <Card size="sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                nativeButton={false}
                aria-label={view === "week" ? tCal("prevWeek") : tCal("prevDay")}
                render={<a href={buildHref(view, anchor.minus({ days: view === "week" ? 7 : 1 }))} />}
              >
                ‹
              </Button>
              <span className="min-w-[170px] text-center text-sm font-medium tabular-nums">
                {view === "week"
                  ? rangeFormatter.formatRange(
                      startOfSundayWeek(anchor).toJSDate(),
                      startOfSundayWeek(anchor).plus({ days: 6 }).toJSDate(),
                    )
                  : dayFormatter.format(anchor.toJSDate())}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                nativeButton={false}
                aria-label={view === "week" ? tCal("nextWeek") : tCal("nextDay")}
                render={<a href={buildHref(view, anchor.plus({ days: view === "week" ? 7 : 1 }))} />}
              >
                ›
              </Button>
            </div>
            <Button variant="outline" size="sm" nativeButton={false} render={<a href={buildHref(view, now)} />}>
              {tCal("today")}
            </Button>
          </div>

          {view === "week" ? (
            <WeekView
              sessions={sessions}
              anchor={anchor}
              now={now}
              locale={locale}
              legend={legend}
              sundayNote={tCal("sundayNote")}
            />
          ) : (
            <DayView sessions={sessions} anchor={anchor} now={now} locale={locale} legend={legend} />
          )}
        </Card>
      )}

      {view === "list" && (
        <Card size="sm">
          <CardContent className="pt-4">
            {sessions.length === 0 ? (
              <EmptyState message={t("empty")} />
            ) : (
              <DataTable>
                <DataTableHead>
                  <DataTableHeaderRow>
                    <DataTableHeaderCell>{t("table.day")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.startTime")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.duration")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.name")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.type")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.countsTowardPromotion")}</DataTableHeaderCell>
                    <DataTableHeaderCell>{t("table.status")}</DataTableHeaderCell>
                    <DataTableHeaderCell>
                      <span className="sr-only">{t("table.actions")}</span>
                    </DataTableHeaderCell>
                  </DataTableHeaderRow>
                </DataTableHead>
                <DataTableBody>
                  {sessions.map((session) => (
                    <DataTableRow key={session.id} className={session.active ? undefined : "opacity-60"}>
                      <DataTableCell>{tDay(session.dayOfWeek)}</DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">{session.startTime}</DataTableCell>
                      <DataTableCell className="tabular-nums">{session.durationMinutes}</DataTableCell>
                      <DataTableCell>{session.name}</DataTableCell>
                      <DataTableCell>{tType(session.type)}</DataTableCell>
                      <DataTableCell>{session.countsTowardPromotion ? t("table.yes") : t("table.no")}</DataTableCell>
                      <DataTableCell>
                        <Pill variant={session.active ? "ok" : "plain"}>
                          {session.active ? t("table.active") : t("table.inactive")}
                        </Pill>
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex flex-col items-start gap-2">
                          <EditClassSessionForm session={session} />
                          {session.active && <DeactivateClassSessionButton classSessionId={session.id} />}
                        </div>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}

type SessionRow = Awaited<ReturnType<typeof listClassSessions>>[number];

function WeekView({
  sessions,
  anchor,
  now,
  locale,
  legend,
  sundayNote,
}: {
  sessions: SessionRow[];
  anchor: DateTime;
  now: DateTime;
  locale: string;
  legend: WeekCalendarLegendItem[];
  sundayNote: string;
}) {
  const weekStart = startOfSundayWeek(anchor);
  const weekDates = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));

  // "Off" (diagonal hatch) is derived from the real data, not hardcoded to
  // Sunday — the "Nueva clase" form lets an admin schedule a Sunday class (or
  // deactivate every class on some other day), and the hatch/legend note
  // must follow that, not silently keep claiming a day is class-free.
  const hasClassesByDay = new Map(
    SUNDAY_FIRST_DAYS.map((day) => [day, sessions.some((session) => session.dayOfWeek === day)]),
  );

  const days: WeekCalendarDay[] = weekDates.map((date, index) => {
    const dayOfWeek = SUNDAY_FIRST_DAYS[index];
    return {
      key: dayOfWeek,
      label: shortWeekdayLabel(date.toJSDate(), locale),
      dateNumber: date.day,
      isToday: date.hasSame(now, "day"),
      isOff: !hasClassesByDay.get(dayOfWeek),
    };
  });

  const sundayHasClasses = hasClassesByDay.get(DayOfWeek.SUNDAY) ?? false;

  return (
    <ScheduleCalendarView
      days={days}
      sessions={sessions}
      legend={legend}
      legendNote={sundayHasClasses ? undefined : sundayNote}
    />
  );
}

function DayView({
  sessions,
  anchor,
  now,
  locale,
  legend,
}: {
  sessions: SessionRow[];
  anchor: DateTime;
  now: DateTime;
  locale: string;
  legend: WeekCalendarLegendItem[];
}) {
  const dayOfWeek = DAY_OF_WEEK_BY_LUXON_WEEKDAY[anchor.weekday];
  const daySessions = sessions.filter((session) => session.dayOfWeek === dayOfWeek);
  const days: WeekCalendarDay[] = [
    {
      key: dayOfWeek,
      label: shortWeekdayLabel(anchor.toJSDate(), locale),
      dateNumber: anchor.day,
      isToday: anchor.hasSame(now, "day"),
      // Same data-derived "off" treatment as WeekView, not hardcoded to
      // SUNDAY — checked against the day's own sessions (already computed
      // just above), active or inactive either way.
      isOff: daySessions.length === 0,
    },
  ];

  return <ScheduleCalendarView days={days} sessions={daySessions} legend={legend} />;
}
