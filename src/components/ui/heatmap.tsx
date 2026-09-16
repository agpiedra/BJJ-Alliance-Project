import { cn } from "cn";

export interface HeatmapCell {
  /** null = no class/no data — renders the dashed empty cell. */
  value: number | null;
  label?: React.ReactNode;
}

export interface HeatmapProps {
  rowLabels: string[];
  colLabels: string[];
  /** cells[row][col] — must match rowLabels.length x colLabels.length. */
  cells: HeatmapCell[][];
  /** Intensity scale ceiling — defaults to the largest cell value. */
  max?: number;
  className?: string;
}

/**
 * REDESIGN_BRIEF.md Phase 3 "Heatmap": cell background is a gold-intensity
 * mix (the brief's prose "--accent" means brand-gold here, same ruling as
 * the sidebar/Button — never the generic --accent token), empty cells get a
 * dashed border and an em dash. Renders a CSS grid, not a <table>, so a row
 * is a label cell followed by N data cells as plain siblings (grid-auto-flow
 * handles the wrapping as long as every row contributes colLabels.length+1
 * children).
 */
export function Heatmap({ rowLabels, colLabels, cells, max, className }: HeatmapProps) {
  const scaleMax = max ?? Math.max(1, ...cells.flat().map((cell) => cell.value ?? 0));

  return (
    <div className={cn("overflow-x-auto", className)}>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `auto repeat(${colLabels.length}, minmax(56px, 1fr))` }}
      >
        <div />
        {colLabels.map((col) => (
          <div
            key={col}
            className="px-1 pb-1 text-center font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase"
          >
            {col}
          </div>
        ))}
        {rowLabels.map((row, rowIndex) => (
          <HeatmapRow key={row} label={row} cells={cells[rowIndex] ?? []} scaleMax={scaleMax} />
        ))}
      </div>
    </div>
  );
}

function HeatmapRow({
  label,
  cells,
  scaleMax,
}: {
  label: string;
  cells: HeatmapCell[];
  scaleMax: number;
}) {
  return (
    <>
      <div className="flex items-center pr-2 text-xs text-muted-foreground">{label}</div>
      {cells.map((cell, index) => {
        if (cell.value == null) {
          return (
            <div
              key={index}
              className="flex aspect-square min-h-10 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground"
            >
              —
            </div>
          );
        }
        const intensity = scaleMax > 0 ? Math.min(100, (cell.value / scaleMax) * 100) : 0;
        return (
          <div
            key={index}
            className="flex aspect-square min-h-10 items-center justify-center rounded text-xs font-medium tabular-nums"
            style={{
              backgroundColor: `color-mix(in srgb, var(--brand-gold) ${intensity}%, var(--card))`,
            }}
          >
            {cell.label ?? cell.value}
          </div>
        );
      })}
    </>
  );
}
