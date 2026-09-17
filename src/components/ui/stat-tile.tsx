import type { ReactNode } from "react";
import { cn } from "cn";

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Context line — brief Rule 5: a stat tile with only a number is incomplete. */
  note?: ReactNode;
  /** REDESIGN_BRIEF.md Phase 3: "green --ok up, red --bad down". */
  delta?: { direction: "up" | "down"; label: ReactNode };
  /** 3px left rail — "accent" (gold, needs-attention) or "bad" (red, urgent). */
  flag?: "accent" | "bad";
  className?: string;
}

export function StatTile({ label, value, note, delta, flag, className }: StatTileProps) {
  return (
    <div className={cn("relative flex flex-col gap-1 bg-card p-4", flag && "pl-5", className)}>
      {flag && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 w-[3px]",
            flag === "accent" ? "bg-brand-gold" : "bg-bad",
          )}
        />
      )}
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-heading text-[30px] leading-none font-semibold tabular-nums">{value}</div>
      {delta && (
        <div className={cn("text-[11.5px]", delta.direction === "up" ? "text-ok" : "text-bad")}>
          {delta.label}
        </div>
      )}
      {note && <div className="text-[11.5px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export interface StatRowProps {
  children: ReactNode;
  /** Grid columns at the `sm` breakpoint and up — defaults to one column per
   * child up to 4, matching Panel's 4-tile row. Resumen's 4x2 layout passes 4.
   * 5/6 added for Phase 3c-iii's kids/adults breakdown alongside the
   * existing stat tiles. */
  columns?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

const COLUMN_CLASS: Record<NonNullable<StatRowProps["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

/**
 * "Tiles sit in one bordered container divided by 1px lines — not separate
 * floating cards" (Phase 3).
 *
 * Draws the dividers with the classic "gap as border" technique — a `gap-px`
 * grid whose own background (`bg-border`) shows through the seams, with each
 * `StatTile` painting its own cell opaque (`bg-card`) — rather than Tailwind's
 * `divide-y`/`divide-x` utilities. `divide-*` adds a border to every child
 * that has a PRECEDING DOM SIBLING, which is exactly right for a single row
 * (or a single stacked column below `sm`) but wrong the moment a grid has
 * more than one row at the same breakpoint (Resumen's 8-tile 4×2 layout):
 * `divide-y` alone would put a spurious top border on cells 2-4 of row 1 too
 * (they all have a preceding sibling), not just on row 2's cells. `gap-px`
 * has no such DOM-order blind spot — it divides every actually-adjacent
 * cell, in both directions, for any row/column count.
 */
export function StatRow({ children, columns = 4, className }: StatRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border",
        COLUMN_CLASS[columns],
        className,
      )}
    >
      {children}
    </div>
  );
}
