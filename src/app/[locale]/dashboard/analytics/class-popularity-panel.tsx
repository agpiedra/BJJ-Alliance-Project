"use client";

import { Fragment } from "react";
import { useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DayOfWeek } from "@/generated/prisma/client";
import type { ClassPopularityRow } from "@/lib/analytics/class-popularity";
import { ExportCsvButton } from "./export-csv-button";

const DAY_ORDER: DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

/**
 * Truncates a bar-chart tick label so 15+ class slots stay legible on a
 * phone-width screen — paired with the 45° rotation in `AngledTick` below,
 * Recharts' own documented pattern for busy categorical axes (a custom tick
 * component), since flat, un-rotated, un-truncated labels overlap into an
 * unreadable mess at that count.
 */
function truncateLabel(label: string, max = 14): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function AngledTick({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const value = payload?.value ?? "";
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{value}</title>
      <text x={0} y={0} dy={10} textAnchor="end" transform="rotate(-45)" fontSize={11} fill="currentColor">
        {truncateLabel(value)}
      </text>
    </g>
  );
}

/**
 * Never a colored glyph alone (spec's accessibility requirement) — the
 * glyph is `aria-hidden`, and the actual trend meaning is carried by the
 * `sr-only` text next to it.
 */
function TrendArrow({ trend }: { trend: ClassPopularityRow["trend"] }) {
  const t = useTranslations("dashboard.analytics.classPopularity.trend");
  const glyph = trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
  const colorClass =
    trend === "up" ? "text-green-600" : trend === "down" ? "text-red-600" : "text-muted-foreground";

  return (
    <span className={colorClass}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{t(trend)}</span>
    </span>
  );
}

/**
 * Day-of-week × start-time heatmap. NOT a Recharts component (Recharts has
 * no first-class heatmap) — a plain CSS grid instead. Rows are the 7 days
 * (fixed `DAY_ORDER`, not just the days present, so an all-quiet day still
 * shows its empty row rather than vanishing); columns are the distinct
 * `startTime` values actually present in `rows`. Every cell shows its raw
 * count as text ALWAYS, in addition to a color-intensity fill — spec's
 * "never rely on color alone" applies to a heatmap most of all.
 */
function Heatmap({ rows }: { rows: ClassPopularityRow[] }) {
  const t = useTranslations("dashboard.analytics.classPopularity");
  const tDay = useTranslations("dayOfWeek");

  const times = Array.from(new Set(rows.map((row) => row.startTime))).sort();
  if (times.length === 0) return null;

  const grid = DAY_ORDER.map((day) =>
    times.map((time) =>
      rows
        .filter((row) => row.dayOfWeek === day && row.startTime === time)
        .reduce((sum, row) => sum + row.attendances, 0),
    ),
  );
  // A simple linear scale against the grid's own max — kept deliberately
  // simple per spec ("this is exactly the kind of visualization spec asks
  // to stay simple"). Floored at 1 so an all-zero grid never divides by
  // zero (every cell then renders at the lightest fill, all showing "0").
  const max = Math.max(1, ...grid.flat());

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{t("heatmap.heading")}</h3>
      <div className="overflow-x-auto">
        <div
          className="grid w-max gap-1"
          style={{ gridTemplateColumns: `100px repeat(${times.length}, minmax(56px, 1fr))` }}
        >
          <div />
          {times.map((time) => (
            <div key={time} className="px-1 text-center text-xs font-medium">
              {time}
            </div>
          ))}
          {DAY_ORDER.map((day, dayIndex) => (
            <Fragment key={day}>
              <div className="flex items-center text-xs font-medium">{tDay(day)}</div>
              {times.map((time, timeIndex) => {
                const value = grid[dayIndex][timeIndex];
                const intensity = value / max;
                return (
                  <div
                    key={`${day}-${time}`}
                    className="flex min-h-8 items-center justify-center rounded text-xs"
                    style={{
                      backgroundColor: `rgba(37, 99, 235, ${0.08 + intensity * 0.72})`,
                      color: intensity > 0.5 ? "white" : undefined,
                    }}
                  >
                    {value}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Class popularity panel (Phase 7 §4 Task 2) — bar chart ranked by
 * `attendances` (already sorted descending by `getClassPopularity`), a
 * day/time heatmap, and per-row trend arrows. `rows` is server-fetched (the
 * page's own `requireStaffSession(["ADMIN", "DIRECTOR"])` +
 * `getClassPopularity`'s self-enforced role gate are the real access
 * control — this component just renders whatever it's handed).
 */
export function ClassPopularityPanel({ rows }: { rows: ClassPopularityRow[] }) {
  const t = useTranslations("dashboard.analytics.classPopularity");
  const tTrend = useTranslations("dashboard.analytics.classPopularity.trend");

  const csvRows = rows.map((row) => ({
    [t("csv.class")]: row.label,
    [t("csv.attendances")]: row.attendances,
    [t("csv.previousAttendances")]: row.previousAttendances,
    [t("csv.trend")]: tTrend(row.trend),
  }));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-class-popularity.csv" />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 64, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" interval={0} height={70} tick={<AngledTick />} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="attendances" name={t("chart.attendances")} fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4">{t("table.rank")}</th>
                  <th className="py-2 pr-4">{t("table.class")}</th>
                  <th className="py-2 pr-4">{t("table.attendances")}</th>
                  <th className="py-2 pr-4">{t("table.previousAttendances")}</th>
                  <th className="py-2 pr-4">{t("table.trend")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.classSessionId} className="border-b">
                    <td className="py-2 pr-4">{index + 1}</td>
                    <td className="py-2 pr-4">{row.label}</td>
                    <td className="py-2 pr-4">{row.attendances}</td>
                    <td className="py-2 pr-4">{row.previousAttendances}</td>
                    <td className="py-2 pr-4">
                      <TrendArrow trend={row.trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Heatmap rows={rows} />
        </>
      )}
    </section>
  );
}
