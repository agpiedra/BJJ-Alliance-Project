import { cn } from "cn";
import { BELT_FILL_CLASS, TIP_FILL_CLASS, type Belt } from "./belt-graphic";

export interface BeltBarProps {
  belt: Belt;
  stripes: number;
  maxStripes?: number;
  className?: string;
}

/**
 * REDESIGN_BRIEF.md Phase 3 "BeltBar": small 86x14 inline bar for table
 * rows/lists — distinct from BeltGraphic's 200x60 hero graphic (kiosk/portal
 * confirmation screens), which stays as-is. "Always paired with text" per
 * the brief, so this is aria-hidden — the caller's own text carries the
 * accessible label (e.g. "Azul · 2 franjas").
 */
export function BeltBar({ belt, stripes, maxStripes = 4, className }: BeltBarProps) {
  const clampedStripes = Math.max(0, Math.min(maxStripes, Math.round(stripes)));

  return (
    <svg viewBox="0 0 86 14" width={86} height={14} aria-hidden className={className}>
      <rect
        x={0.5}
        y={0.5}
        width={85}
        height={13}
        rx={2}
        className={cn(BELT_FILL_CLASS[belt], "stroke-border")}
        strokeWidth={1}
      />
      <rect x={56} y={0.5} width={29.5} height={13} className={TIP_FILL_CLASS[belt]} />
      {Array.from({ length: clampedStripes }, (_, index) => (
        <rect key={index} x={60 + index * 6} y={2.5} width={2.5} height={9} className="fill-belt-white" />
      ))}
    </svg>
  );
}
