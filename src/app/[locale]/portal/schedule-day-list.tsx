"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import type { WeekCalendarBlock, WeekCalendarDay } from "@/components/ui/week-calendar";

/**
 * The same week as `WeekCalendar` (same days, same blocks, same class-type colours), as a phone-only day-at-a-
 * time picker — a seven-column grid is not readable at phone widths. Presentation only: it takes the calendar's
 * own props, so the two can never disagree, and touches no schedule data or query. Day-tabs are always
 * selectable (unlike the old stacked-sections layout, which hid a day entirely when it had no classes) — a
 * selected empty day shows an explicit "no classes" message instead of disappearing.
 */
export function ScheduleDayList({
  days,
  blocks,
  sundayHasClasses,
  dateHeadings,
}: {
  days: WeekCalendarDay[];
  blocks: WeekCalendarBlock[];
  sundayHasClasses: boolean;
  /** Full weekday + month + day label per day key (e.g. "Friday, September 25") — the selected day's complete
   * date stays visible here, never abbreviated down to the day-tab's own short weekday + day-number label. */
  dateHeadings: Record<string, string>;
}) {
  const tCalendar = useTranslations("adminSchedule.calendar");
  const t = useTranslations("portal.schedule.dayPicker");
  const todayKey = days.find((d) => d.isToday)?.key ?? days[0]?.key;
  const [selected, setSelected] = useState(todayKey);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    // The already-selected day-tab can load scrolled out of view at phone widths (all 7 tabs overflow the row) —
    // bring it into view on mount/change so it's visible without the user first discovering horizontal scroll.
    tabRefs.current[selected]?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [selected]);

  if (days.length === 0) return null;
  const activeDay = days.find((d) => d.key === selected) ?? days[0];
  const activeBlocks = blocks.filter((b) => b.dayKey === activeDay.key).sort((a, b) => a.startRow - b.startRow);
  const isEmptySunday = activeDay.key === "SUNDAY" && !sundayHasClasses;

  return (
    <div className="flex flex-col gap-3 p-4 md:hidden" data-testid="schedule-day-list">
      <div role="tablist" aria-label={t("label")} className="flex gap-2 overflow-x-auto pb-1">
        {days.map((day) => {
          const isActive = day.key === selected;
          return (
            <button
              key={day.key}
              ref={(el) => {
                tabRefs.current[day.key] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={day.isToday ? "date" : undefined}
              onClick={() => setSelected(day.key)}
              className={cn(
                "flex min-h-16 min-w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border px-2 text-sm font-medium",
                isActive ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
              )}
            >
              <span>{day.label}</span>
              <span className="tabular-nums">{day.dateNumber}</span>
            </button>
          );
        })}
      </div>

      <section aria-current={activeDay.isToday ? "date" : undefined} className="flex flex-col gap-2">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
          <span>{dateHeadings[activeDay.key] ?? `${activeDay.label} ${activeDay.dateNumber}`}</span>
          {activeDay.isToday && <span className="rounded-full border border-foreground px-2 py-0.5 text-xs font-medium">{tCalendar("today")}</span>}
        </h3>
        {activeBlocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{isEmptySunday ? tCalendar("sundayNote") : t("noClasses")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activeBlocks.map((block) => (
              <li
                key={block.id}
                className={cn("flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm text-white", block.colorClassName, block.dimmed && "opacity-60")}
              >
                <span className="font-medium">{block.title}</span>
                <span className="font-mono text-xs tabular-nums">{block.timeLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
