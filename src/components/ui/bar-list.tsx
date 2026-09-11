import type { ReactNode } from "react";
import { cn } from "cn";

export interface BarListItem {
  key: string;
  label: ReactNode;
  value: number;
  displayValue?: ReactNode;
  /** Tailwind bg-* class for the filled bar — defaults to brand gold. Pass a
   * belt or class token class (e.g. "bg-belt-blue") for belt/modality bars. */
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
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", item.colorClassName ?? "bg-brand-gold")}
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
