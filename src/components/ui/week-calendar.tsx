"use client";

import { Fragment } from "react";
import { cn } from "cn";

/**
 * REDESIGN_BRIEF.md Phase 5 "WeekCalendar". Generic/reusable: no Prisma
 * imports, only plain serializable props — Phase 8's read-only student-portal
 * variant (a later, separate task) is expected to reuse this same component,
 * so callers own translating their own domain data (ClassSession rows, etc.)
 * into these plain shapes.
 */

export const CALENDAR_START_HOUR = 6;
export const CALENDAR_END_HOUR = 20; // exclusive — last half-hour track ends at 20:00

/**
 * The brief's own formula: grid row 2 is 06:00, each hour is 2 half-hour
 * tracks. Exported so the row-placement math has a direct unit test.
 */
export function rowFor(hour: number, minute: number): number {
  return 2 + (hour - CALENDAR_START_HOUR) * 2 + (minute === 30 ? 1 : 0);
}

export interface WeekCalendarDay {
  /** Stable key matched against WeekCalendarBlock.dayKey. */
  key: string;
  /** Short column label (e.g. a locale-formatted weekday abbreviation). */
  label: string;
  dateNumber?: string | number;
  isToday?: boolean;
  /** Diagonal-hatch treatment for a day with no classes (e.g. Sunday). */
  isOff?: boolean;
}

export interface WeekCalendarBlock {
  id: string;
  dayKey: string;
  title: string;
  timeLabel: string;
  /** Inclusive start row from `rowFor`. */
  startRow: number;
  /** Exclusive end row from `rowFor` — touching another block's startRow is
   * NOT an overlap. */
  endRow: number;
  /** A `bg-class-*` (or equivalent token) utility class — solid color, white
   * text is applied by the calendar itself. */
  colorClassName: string;
  /** Inactive sessions render dimmed rather than being hidden entirely. */
  dimmed?: boolean;
}

export interface WeekCalendarLegendItem {
  colorClassName: string;
  label: string;
}

export interface OverlapLayout {
  id: string;
  columnIndex: number;
  columnCount: number;
}

function rangesOverlap(
  a: { startRow: number; endRow: number },
  b: { startRow: number; endRow: number },
): boolean {
  return a.startRow < b.endRow && b.startRow < a.endRow;
}

/**
 * REDESIGN_BRIEF.md Phase 5's overlap-handling requirement: a real
 * pairwise overlap check (every pair in the same day column), not a
 * hardcoded "18:30 vs 19:00" special case. Overlapping blocks split the
 * column width evenly; non-overlapping blocks (including two that only
 * touch — one's end equals the other's start) each keep the full width.
 *
 * ponytail: O(n^2) pairwise comparison, and one shared lane count per whole
 * connected overlap group rather than a finer per-instant lane count. Both
 * are fine at this app's real scale (a handful of blocks per day) — revisit
 * with an interval-tree / sweep-line approach if a single day ever has
 * dozens of sessions.
 */
export function layoutOverlappingBlocks<T extends { id: string; startRow: number; endRow: number }>(
  blocks: T[],
): OverlapLayout[] {
  const n = blocks.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i: number, j: number) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rangesOverlap(blocks[i], blocks[j])) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const result: OverlapLayout[] = new Array(n);
  for (const indices of groups.values()) {
    const sorted = [...indices].sort((a, b) => blocks[a].startRow - blocks[b].startRow || a - b);
    const columnEnds: number[] = [];
    const columnByIndex = new Map<number, number>();
    for (const idx of sorted) {
      const block = blocks[idx];
      let placed = -1;
      for (let c = 0; c < columnEnds.length; c++) {
        if (columnEnds[c] <= block.startRow) {
          columnEnds[c] = block.endRow;
          placed = c;
          break;
        }
      }
      if (placed === -1) {
        columnEnds.push(block.endRow);
        placed = columnEnds.length - 1;
      }
      columnByIndex.set(idx, placed);
    }
    const columnCount = columnEnds.length;
    for (const idx of indices) {
      result[idx] = { id: blocks[idx].id, columnIndex: columnByIndex.get(idx)!, columnCount };
    }
  }
  return result;
}

/**
 * Clamps a block's row range to the grid's visible window [minRow, maxRow),
 * returning null when the block falls entirely outside it. The row-placement
 * formula (`rowFor`) has no built-in bound — the "Nueva clase" form accepts
 * any "HH:mm" start and up to 600 minutes duration, so a class outside
 * [startHour, endHour) is reachable in practice (a 05:00 class produces row
 * 0, an invalid CSS grid line; a 04:00 class produces a negative line, which
 * CSS silently reinterprets as counting from the grid's end) even though the
 * current seed data never produces one. Exported so this can be unit-tested
 * without rendering CSS.
 */
export function clampBlockRows(
  startRow: number,
  endRow: number,
  minRow: number,
  maxRow: number,
): { startRow: number; endRow: number } | null {
  if (endRow <= minRow || startRow >= maxRow) return null;
  return { startRow: Math.max(minRow, startRow), endRow: Math.min(maxRow, endRow) };
}

export interface WeekCalendarProps {
  days: WeekCalendarDay[];
  blocks: WeekCalendarBlock[];
  legend?: WeekCalendarLegendItem[];
  /** Trailing note in the legend row (e.g. "Domingo sin clases"). */
  legendNote?: string;
  /** Omit for a read-only calendar (renders blocks as non-interactive). */
  onBlockClick?: (blockId: string) => void;
  startHour?: number;
  endHour?: number;
  className?: string;
}

export function WeekCalendar({
  days,
  blocks,
  legend,
  legendNote,
  onBlockClick,
  startHour = CALENDAR_START_HOUR,
  endHour = CALENDAR_END_HOUR,
  className,
}: WeekCalendarProps) {
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const totalTracks = (endHour - startHour) * 2;
  const minRow = 2;
  const maxRow = totalTracks + 2;

  const layoutById = new Map<string, OverlapLayout>();
  for (const day of days) {
    const dayBlocks = blocks.filter((block) => block.dayKey === day.key);
    for (const layout of layoutOverlappingBlocks(dayBlocks)) {
      layoutById.set(layout.id, layout);
    }
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="overflow-x-auto">
        <div
          className="relative grid"
          style={{
            // The brief's 860px min-width is sized for the 7-column week
            // grid, so IT scrolls horizontally instead of crushing — the
            // 1-column Día view must NOT inherit that same fixed width, or
            // it forces sideways scroll on exactly the view meant to be
            // phone-friendly. Scale with the actual column count instead.
            minWidth: 70 + days.length * 113,
            gridTemplateColumns: `70px repeat(${days.length}, minmax(104px, 1fr))`,
            gridTemplateRows: `auto repeat(${totalTracks}, 24px)`,
          }}
        >
          <div
            className="sticky top-0 z-3 border-b border-border bg-muted"
            style={{ gridRow: 1, gridColumn: 1 }}
          />

          {days.map((day, index) => (
            <div
              key={day.key}
              className={cn(
                "sticky top-0 z-3 border-b border-l border-border bg-muted px-1.5 py-2 text-center",
                day.isToday && "border-b-brand-gold bg-brand-gold/10",
              )}
              style={{ gridRow: 1, gridColumn: index + 2 }}
            >
              <div
                className={cn(
                  "font-mono text-[9.5px] tracking-[.11em] text-muted-foreground uppercase",
                  day.isToday && "text-brand-gold",
                )}
              >
                {day.label}
              </div>
              {day.dateNumber !== undefined && (
                <div className="mt-0.5 font-heading text-base leading-tight font-semibold tabular-nums">
                  {day.dateNumber}
                </div>
              )}
            </div>
          ))}

          {days.map((day, index) => (
            <div
              key={day.key}
              className={cn(
                "border-l border-border",
                day.isToday && "bg-[color-mix(in_srgb,var(--brand-gold)_7%,transparent)]",
              )}
              style={{
                gridRow: "2 / -1",
                gridColumn: index + 2,
                ...(day.isOff
                  ? {
                      backgroundImage:
                        "repeating-linear-gradient(135deg, transparent, transparent 7px, var(--muted) 7px, var(--muted) 14px)",
                    }
                  : undefined),
              }}
            />
          ))}

          {hours.map((hour) => (
            <Fragment key={hour}>
              <div
                className="pr-2 text-right font-mono text-[10px] text-muted-foreground"
                style={{ gridRow: rowFor(hour, 0), gridColumn: 1, transform: "translateY(-6px)" }}
              >
                {String(hour).padStart(2, "0")}:00
              </div>
              <div className="border-t border-border" style={{ gridRow: rowFor(hour, 0), gridColumn: "2 / -1" }} />
            </Fragment>
          ))}

          {blocks.map((block) => {
            const dayIndex = days.findIndex((day) => day.key === block.dayKey);
            if (dayIndex === -1) return null;
            const clamped = clampBlockRows(block.startRow, block.endRow, minRow, maxRow);
            if (!clamped) return null;
            const layout = layoutById.get(block.id) ?? { id: block.id, columnIndex: 0, columnCount: 1 };
            const widthPct = 100 / layout.columnCount;
            const leftPct = layout.columnIndex * widthPct;
            const style: React.CSSProperties = {
              gridRow: `${clamped.startRow} / ${clamped.endRow}`,
              gridColumn: dayIndex + 2,
              marginLeft: `calc(${leftPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
            };
            const blockClassName = cn(
              "z-2 flex flex-col gap-0.5 overflow-hidden rounded-md p-1.5 text-left text-white transition-[filter,transform] duration-100",
              block.colorClassName,
              block.dimmed && "opacity-50",
              onBlockClick && "cursor-pointer hover:z-4 hover:-translate-y-px hover:brightness-[1.08] focus-visible:z-4",
            );
            const content = (
              <>
                <span className="truncate text-[11.5px] leading-tight font-semibold">{block.title}</span>
                <span className="mt-auto font-mono text-[9.5px] leading-tight opacity-80">{block.timeLabel}</span>
              </>
            );
            return onBlockClick ? (
              <button
                key={block.id}
                type="button"
                onClick={() => onBlockClick(block.id)}
                className={blockClassName}
                style={style}
              >
                {content}
              </button>
            ) : (
              <div key={block.id} className={blockClassName} style={style}>
                {content}
              </div>
            );
          })}
        </div>
      </div>

      {legend && legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-3.5 border-t border-border px-4 py-3.5 text-xs text-muted-foreground">
          {legend.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("inline-block size-2.5 rounded-sm", item.colorClassName)} />
              {item.label}
            </span>
          ))}
          {legendNote && <span className="ml-auto">{legendNote}</span>}
        </div>
      )}
    </div>
  );
}
