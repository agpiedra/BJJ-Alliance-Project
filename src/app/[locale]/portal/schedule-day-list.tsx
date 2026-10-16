"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import type { WeekCalendarBlock, WeekCalendarDay } from "@/components/ui/week-calendar";

/**
 * The same week as `WeekCalendar` (same days, same blocks, same class-type colours), as a phone-only day-at-a-
 * time picker — a seven-column grid is not readable at phone widths. Presentation only: it takes the calendar's
 * own props, so the two can never disagree, and touches no schedule data or query. Day-tabs are always
 * selectable (unlike the old stacked-sections layout, which hid a day entirely when it had no classes) — a
 * selected empty day shows an explicit "no classes" message instead of disappearing.
 *
 * ACCESSIBLE TABS (WAI-ARIA tabs pattern, automatic activation), same convention as `PortalTabs`: a labelled
 * `tablist`, `role="tab"` buttons with `aria-selected`/`aria-controls` and a roving tabindex (Left/Right wrap,
 * Home/End jump, each move both focuses and selects), and a `role="tabpanel"` labelled by its tab.
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
  const tablistRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /** Adjusts ONLY the tablist's own horizontal scroll, never `scrollIntoView` (which can move an
   * ancestor scroll container, including the page, in ways this component doesn't control and can't
   * verify). A no-op when the selected tab is already fully within the visible range — this never
   * recenters an already-visible tab, only brings a genuinely out-of-view one to the nearest edge.
   *
   * Uses `getBoundingClientRect()`, not `offsetLeft`/`offsetWidth` — this tablist has no `position`,
   * so a tab's `offsetLeft` resolves against whatever positioned ancestor the browser finds next
   * (an unrelated coordinate space, not this scroll container's own content), which silently broke
   * the very first real-browser check of this fix. `getBoundingClientRect()` is always relative to
   * the viewport, so subtracting the tablist's own rect and adding its current `scrollLeft` gives the
   * tab's true position within the tablist's scrollable content, regardless of any ancestor's
   * positioning. */
  function ensureSelectedTabVisible() {
    const tablist = tablistRef.current;
    const tab = tabRefs.current[selectedRef.current];
    if (!tablist || !tab) return;
    const tabRect = tab.getBoundingClientRect();
    const listRect = tablist.getBoundingClientRect();
    const tabLeft = tabRect.left - listRect.left + tablist.scrollLeft;
    const tabRight = tabRect.right - listRect.left + tablist.scrollLeft;
    const viewLeft = tablist.scrollLeft;
    const viewRight = viewLeft + tablist.clientWidth;
    if (tabLeft < viewLeft) tablist.scrollLeft = tabLeft;
    else if (tabRight > viewRight) tablist.scrollLeft = tabRight - tablist.clientWidth;
  }

  useEffect(() => {
    ensureSelectedTabVisible();
  }, [selected]);

  // The tablist can mount — or later become visible — at zero width: its parent portal panel still
  // `hidden`, or this component's own `md:hidden` CSS boundary not yet crossed. `selected` never
  // changes just because visibility changes, so the effect above alone misses that moment entirely.
  // A ResizeObserver reacts to the container's own rendered size regardless of WHY it changed — this
  // is what makes it fire on a parent-hidden-attribute flip AND on a desktop<->phone resize alike,
  // and (unlike IntersectionObserver) NOT fire just because the page was scrolled vertically.
  useEffect(() => {
    const el = tablistRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0 && lastWidth === 0) ensureSelectedTabVisible();
      lastWidth = width;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (days.length === 0) return null;
  const activeDay = days.find((d) => d.key === selected) ?? days[0];
  const activeBlocks = blocks.filter((b) => b.dayKey === activeDay.key).sort((a, b) => a.startRow - b.startRow);
  const isEmptySunday = activeDay.key === "SUNDAY" && !sundayHasClasses;

  function select(key: string, options?: { focus?: boolean }) {
    setSelected(key);
    if (options?.focus) tabRefs.current[key]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = days.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    select(days[next].key, { focus: true });
  }

  return (
    <div className="flex flex-col gap-3 p-4 md:hidden" data-testid="schedule-day-list">
      <div ref={tablistRef} role="tablist" aria-label={t("label")} className="flex gap-2 overflow-x-auto pb-1">
        {days.map((day, index) => {
          const isActive = day.key === selected;
          const hasClasses = !day.isOff;
          return (
            <button
              key={day.key}
              ref={(el) => {
                tabRefs.current[day.key] = el;
              }}
              type="button"
              role="tab"
              id={`schedule-day-tab-${day.key}`}
              aria-selected={isActive}
              aria-controls={`schedule-day-panel-${day.key}`}
              aria-current={day.isToday ? "date" : undefined}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(day.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "flex min-h-16 min-w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border px-2 text-sm font-medium",
                isActive ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
              )}
            >
              <span>{day.label}</span>
              <span className="tabular-nums">{day.dateNumber}</span>
              {hasClasses && (
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", isActive ? "bg-background" : "bg-muted-foreground")}
                />
              )}
            </button>
          );
        })}
      </div>

      <section
        role="tabpanel"
        id={`schedule-day-panel-${activeDay.key}`}
        aria-labelledby={`schedule-day-tab-${activeDay.key}`}
        aria-current={activeDay.isToday ? "date" : undefined}
        className="flex flex-col gap-2"
      >
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
                className={cn(
                  "flex items-stretch gap-3 overflow-hidden rounded-md border border-border bg-card text-sm",
                  block.dimmed && "opacity-60",
                )}
              >
                <span aria-hidden="true" className={cn("w-1.5 shrink-0", block.colorClassName)} />
                <div className="flex flex-1 flex-col gap-0.5 py-2.5 pr-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{block.title}</span>
                    <span className="font-mono text-xs tabular-nums">{block.timeLabel}</span>
                  </div>
                  {block.meta && <span className="text-xs text-muted-foreground">{block.meta}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
