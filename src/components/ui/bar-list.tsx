import type { ReactNode } from "react";
import { cn } from "cn";

export interface BarListItem {
  key: string;
  label: ReactNode;
  value: number;
  displayValue?: ReactNode;
  /** Tailwind bg-* class for the filled bar — defaults to the fixed,
   * non-brand-configurable data color (`bg-data`, never `bg-brand-gold`:
   * a director's chosen brand color can be pale enough to make a bar
   * invisible against `bg-muted`, live and confirmed via
   * class-popularity-panel.tsx, which never overrode this default). Pass a
   * belt or class token class (e.g. "bg-belt-blue") for belt/modality bars,
   * where the color IS the data (semantically correct, not this bug). */
  colorClassName?: string;
}

export interface BarListProps {
  items: BarListItem[];
  /** Scale ceiling — defaults to the largest item's value. */
  max?: number;
  className?: string;
}

/**
 * REDESIGN_BRIEF.md Phase 3 "BarList": "Replaces every rotated-label bar
 * chart in the app." Caller decides when there's no data to show — this
 * renders whatever `items` it's given, empty-state handling is the page's
 * job (Rule 4).
 */
export function BarList({ items, max, className }: BarListProps) {
  const scaleMax = max ?? Math.max(1, ...items.map((item) => item.value));
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => {
        const pct = scaleMax > 0 ? Math.min(100, (item.value / scaleMax) * 100) : 0;
        return (
          <div key={item.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3">
            <span className="truncate text-sm">{item.label}</span>
            {/* ring-inset border: a light fill color (e.g. bg-belt-white) at
                100% width would otherwise be nearly invisible against this
                same near-white track in light mode — caught live in a
                browser on the Panel's belt-distribution bar, not by
                code-only review. */}
            <span className="h-2 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border">
              <span
                className={cn("block h-full rounded-full", item.colorClassName ?? "bg-data")}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="justify-self-end font-mono text-xs tabular-nums">
              {item.displayValue ?? item.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
