"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Pill } from "@/components/ui/pill";
import {
  WeekCalendar,
  rowFor,
  type WeekCalendarBlock,
  type WeekCalendarDay,
  type WeekCalendarLegendItem,
} from "@/components/ui/week-calendar";
import { EditClassSessionForm } from "./edit-class-session-form";
import { DeactivateClassSessionButton } from "./deactivate-class-session-button";
import { addMinutesToClockTime, CLASS_TYPE_COLOR_CLASS } from "./calendar-helpers";
import type { ClassType, DayOfWeek } from "@/generated/prisma/browser";

export interface CalendarSession {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  durationMinutes: number;
  name: string;
  type: ClassType;
  countsTowardPromotion: boolean;
  active: boolean;
}

/**
 * Page-local wiring on top of the generic `WeekCalendar` (src/components/ui):
 * turns `ClassSession` rows into plain calendar blocks and owns the
 * click-to-detail Sheet. Scoped exactly per REDESIGN_BRIEF.md Phase 5's
 * ruling — no instructor line (no schema field for it) and no "mark
 * attendance" UI, only the class's own info plus the existing edit/deactivate
 * actions, reused as-is.
 */
export function ScheduleCalendarView({
  organizationId,
  days,
  sessions,
  legend,
  legendNote,
}: {
  organizationId: string;
  days: WeekCalendarDay[];
  sessions: CalendarSession[];
  legend: WeekCalendarLegendItem[];
  legendNote?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const t = useTranslations("adminSchedule");
  const tDay = useTranslations("dayOfWeek");
  const tType = useTranslations("classType");

  const blocks: WeekCalendarBlock[] = sessions.map((session) => {
    const [hour, minute] = session.startTime.split(":").map(Number);
    const end = addMinutesToClockTime(session.startTime, session.durationMinutes);
    return {
      id: session.id,
      dayKey: session.dayOfWeek,
      title: session.name,
      timeLabel: `${session.startTime} – ${end.label}`,
      startRow: rowFor(hour, minute),
      endRow: rowFor(end.hour, end.minute),
      colorClassName: CLASS_TYPE_COLOR_CLASS[session.type],
      dimmed: !session.active,
    };
  });

  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  return (
    <>
      <WeekCalendar days={days} blocks={blocks} legend={legend} legendNote={legendNote} onBlockClick={setSelectedId} />

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent>
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name}</SheetTitle>
                <SheetDescription>
                  {tType(selected.type)} · {tDay(selected.dayOfWeek)}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 px-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("table.startTime")}</span>
                  <span className="font-mono tabular-nums">
                    {selected.startTime} – {addMinutesToClockTime(selected.startTime, selected.durationMinutes).label}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("table.duration")}</span>
                  <span className="tabular-nums">
                    {selected.durationMinutes} {t("calendar.minutesUnit")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("table.countsTowardPromotion")}</span>
                  <span>{selected.countsTowardPromotion ? t("table.yes") : t("table.no")}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("table.status")}</span>
                  <Pill variant={selected.active ? "ok" : "plain"}>
                    {selected.active ? t("table.active") : t("table.inactive")}
                  </Pill>
                </div>
              </div>
              <div className="flex flex-col gap-3 border-t border-border px-4 pt-4">
                <EditClassSessionForm organizationId={organizationId} session={selected} renderAsDetails={false} />
                {selected.active && (
                  <DeactivateClassSessionButton organizationId={organizationId} classSessionId={selected.id} />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
