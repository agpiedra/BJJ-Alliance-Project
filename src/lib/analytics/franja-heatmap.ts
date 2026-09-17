import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { ZONE } from "@/lib/scheduling/zone";
import type { DayOfWeek } from "@/generated/prisma/client";

/**
 * Panel's "Asistencia promedio por franja" heatmap (REDESIGN_BRIEF.md §4.1
 * Task 3a) — every staff role, no role gate (unlike `getWeeklyAttendanceTrend`
 * next to it, which is ADMIN/DIRECTOR only). Scoped by `getScopedDb` +
 * `branchScopeWhere` exactly like every other panel query in this file's
 * sibling modules.
 */
export const FRANJA_WINDOW_WEEKS = 4;

export type TimeBand = "morning" | "midday" | "afternoon" | "evening";

export const TIME_BAND_ORDER: readonly TimeBand[] = ["morning", "midday", "afternoon", "evening"];

/**
 * The mock's own panel excludes Sunday (unlike the full week calendar in
 * Phase 5) — this app's seeded schedule has no Sunday classes at all, so a
 * Sunday column would always render as a fully-dashed empty row.
 */
export const FRANJA_DAY_ORDER: readonly DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

/**
 * Boundary hours are not specified by the brief ("you decide sensible
 * boundary hours, e.g. 6-11/11-15/15-18/18-22"). The brief's own example
 * boundaries would leave "Tarde" completely empty for this academy's actual
 * schedule (no class starts between 15:00 and 18:00 anywhere in
 * `prisma/seed.ts`) while dumping both the 18:00/18:30 AND 19:00 classes into
 * one "Noche" bucket — exactly the Wed/Fri overlap the mock's own two
 * distinct "Tarde 18:00–18:30" / "Noche 19:00" columns are keeping apart. The
 * boundary is moved to 19:00 instead, which reproduces the mock's grouping
 * against the real seeded start times.
 */
const BAND_BOUNDS: Record<TimeBand, { startHour: number; endHour: number }> = {
  morning: { startHour: 6, endHour: 11 },
  midday: { startHour: 11, endHour: 15 },
  afternoon: { startHour: 15, endHour: 19 },
  evening: { startHour: 19, endHour: 22 },
};

/**
 * Pure: which time band a `ClassSession.startTime` ("HH:mm") falls in. `null`
 * for anything outside 06:00–22:00 (this academy has no such classes today,
 * but a future one shouldn't silently land in the wrong band).
 */
export function bandForStartTime(startTime: string): TimeBand | null {
  const hour = Number(startTime.slice(0, 2));
  if (!Number.isFinite(hour)) return null;
  for (const band of TIME_BAND_ORDER) {
    const { startHour, endHour } = BAND_BOUNDS[band];
    if (hour >= startHour && hour < endHour) return band;
  }
  return null;
}

export interface FranjaCell {
  /** Average attendances per week over the trailing window, rounded to the
   * nearest whole attendee — `null` when no class occupies this day/band
   * slot at all (renders as the Heatmap's dashed empty cell). */
  average: number | null;
  /** Class name(s) occupying the slot, joined with " / " when two classes
   * share a day/band bucket (e.g. Saturday's Striking + Kids both land in
   * "morning"). `null` alongside `average: null`. */
  classLabel: string | null;
}

/**
 * `cells[dayIndex][bandIndex]` matching `FRANJA_DAY_ORDER` x
 * `TIME_BAND_ORDER` — the exact shape `Heatmap`'s `cells` prop
 * (`src/components/ui/heatmap.tsx`) expects once mapped to `HeatmapCell`.
 *
 * When two `ClassSession`s share one day/band bucket (Saturday
 * morning: Striking 09:00 + Kids 10:00), their per-week averages are summed
 * — this stays a single "how full does the tatami run in this slot" number,
 * not two competing cells.
 */
export async function getFranjaHeatmap(
  context: TenantContext,
  windowWeeks: number = FRANJA_WINDOW_WEEKS,
  now: DateTime = DateTime.now().setZone(ZONE),
): Promise<FranjaCell[][]> {
  const classSessions = await getScopedDb(context).classSession.findMany({
    where: { ...branchScopeWhere(context), dayOfWeek: { in: [...FRANJA_DAY_ORDER] } },
    select: { id: true, dayOfWeek: true, startTime: true, name: true },
  });

  const windowStart = now.minus({ weeks: windowWeeks });
  const sessionIds = classSessions.map((cs) => cs.id);
  const attendances =
    sessionIds.length === 0
      ? []
      : await prisma.attendanceRecord.findMany({
          where: {
            classSessionId: { in: sessionIds },
            organizationId: context.organizationId,
            type: "CHECKIN",
            occurredAt: { gte: windowStart.toJSDate(), lte: now.toJSDate() },
          },
          select: { classSessionId: true },
        });

  const countBySessionId = new Map<string, number>();
  for (const attendance of attendances) {
    if (!attendance.classSessionId) continue;
    countBySessionId.set(attendance.classSessionId, (countBySessionId.get(attendance.classSessionId) ?? 0) + 1);
  }

  const grid: FranjaCell[][] = FRANJA_DAY_ORDER.map(() =>
    TIME_BAND_ORDER.map(() => ({ average: null, classLabel: null }) satisfies FranjaCell),
  );

  for (const classSession of classSessions) {
    const band = bandForStartTime(classSession.startTime);
    if (!band) continue;
    const dayIndex = FRANJA_DAY_ORDER.indexOf(classSession.dayOfWeek);
    const bandIndex = TIME_BAND_ORDER.indexOf(band);
    if (dayIndex === -1) continue;

    const count = countBySessionId.get(classSession.id) ?? 0;
    const average = Math.round(count / windowWeeks);
    const existing = grid[dayIndex][bandIndex];
    grid[dayIndex][bandIndex] =
      existing.average === null
        ? { average, classLabel: classSession.name }
        : { average: existing.average + average, classLabel: `${existing.classLabel} / ${classSession.name}` };
  }

  return grid;
}
