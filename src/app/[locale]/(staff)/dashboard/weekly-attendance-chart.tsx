"use client";

import { useLocale } from "next-intl";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/ui/empty-state";

export interface WeeklyAttendancePoint {
  weekStart: string;
  count: number;
}

interface DotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: WeeklyAttendancePoint;
}

/**
 * REDESIGN_BRIEF.md §4.1 Task 2a: "8-week line+area chart... last point
 * emphasized with a filled dot and its value labeled." Recharts has no
 * first-class "emphasize just the last point" option, so the dot renderer
 * below special-cases `index === data.length - 1` — Recharts' own documented
 * pattern for a per-point custom dot (a `dot` render-prop function).
 *
 * Tokens only (Rule 1): every stroke/fill here is a `var(--…)` CSS custom
 * property, never a hardcoded color literal — unlike the pre-existing
 * (out-of-scope) `retention-panel.tsx`/`class-popularity-panel.tsx`, which
 * still hardcode a literal blue.
 *
 * Uses `--data`, not `--brand-gold`: this chart's line/area color is real
 * chart data, not chrome, and `--brand-gold` is a director's own
 * configurable brand color (`branding-scope.tsx` overrides it per
 * organization) — a pale gold pick made this chart's own line nearly
 * invisible against `--card`, confirmed live before this fix.
 */
export function WeeklyAttendanceChart({
  data,
  emptyMessage,
  countLabel,
}: {
  data: WeeklyAttendancePoint[];
  emptyMessage: string;
  countLabel: string;
}) {
  const locale = useLocale();

  // Rule 4: never render a blank/flat-zero chart — an 8-week window with no
  // signal at all (brand-new academy, or a data gap) gets the empty state
  // instead of a chart that's technically non-empty but meaningless.
  const hasSignal = data.some((point) => point.count > 0);
  if (!hasSignal) {
    return <EmptyState message={emptyMessage} />;
  }

  const formatWeek = (iso: string) =>
    new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(iso));

  const lastIndex = data.length - 1;

  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 4" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="weekStart"
            tickFormatter={formatWeek}
            tick={{ fontSize: 9.5, fill: "var(--muted-foreground)" }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
          />
          <YAxis hide allowDecimals={false} />
          <Tooltip
            labelFormatter={(value) => formatWeek(String(value))}
            formatter={(value) => [value, countLabel]}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="var(--data)"
            strokeWidth={2.4}
            fill="var(--data)"
            fillOpacity={0.13}
            dot={(dotProps: DotRenderProps) => {
              const { cx, cy, index, payload } = dotProps;
              const isLast = index === lastIndex;
              return (
                <g key={`weekly-attendance-dot-${index}`}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isLast ? 5 : 2.8}
                    fill={isLast ? "var(--data)" : "var(--card)"}
                    stroke="var(--data)"
                    strokeWidth={isLast ? 2 : 1.8}
                  />
                  {isLast && payload && (
                    <text
                      x={cx}
                      y={(cy ?? 0) - 12}
                      textAnchor="middle"
                      fontSize={11.5}
                      fontWeight={600}
                      fill="var(--foreground)"
                    >
                      {payload.count}
                    </text>
                  )}
                </g>
              );
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
