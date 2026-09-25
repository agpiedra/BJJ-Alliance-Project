import { useTranslations } from "next-intl";
import { cn } from "cn";
import type { WeekCalendarBlock, WeekCalendarDay } from "@/components/ui/week-calendar";

/**
 * The same week as `WeekCalendar` (same days, same blocks, same class-type colours), as a day-by-day list for phones, where a seven-column
 * grid is not readable. Presentation only: it takes the calendar's own props, so the two can never disagree. Days without classes are
 * left out, except a Sunday with none, which keeps the calendar's "No classes on Sunday" note. Today is marked with text (not colour
 * alone) and `aria-current="date"`.
 */
export function ScheduleDayList({ days, blocks, sundayHasClasses }: { days: WeekCalendarDay[]; blocks: WeekCalendarBlock[]; sundayHasClasses: boolean }) {
  const tCalendar = useTranslations("adminSchedule.calendar");
  return (
    <div className="flex flex-col gap-4 p-4 md:hidden" data-testid="schedule-day-list">
      {days.map((day) => {
        const dayBlocks = blocks.filter((b) => b.dayKey === day.key).sort((a, b) => a.startRow - b.startRow);
        const isSunday = day.key === "SUNDAY";
        if (dayBlocks.length === 0 && !(isSunday && !sundayHasClasses)) return null;
        return (
          <section key={day.key} aria-current={day.isToday ? "date" : undefined} className="flex flex-col gap-2">
            <h3 className="flex items-baseline gap-2 text-sm font-semibold">
              <span>
                {day.label} {day.dateNumber}
              </span>
              {day.isToday && <span className="rounded-full border border-foreground px-2 py-0.5 text-xs font-medium">{tCalendar("today")}</span>}
            </h3>
            {dayBlocks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tCalendar("sundayNote")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {dayBlocks.map((block) => (
                  <li key={block.id} className={cn("flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm text-white", block.colorClassName, block.dimmed && "opacity-60")}>
                    <span className="font-medium">{block.title}</span>
                    <span className="font-mono text-xs tabular-nums">{block.timeLabel}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
