import { BeltVisual, type BeltVisualData } from "./belt-graphic";

export interface BeltBarProps {
  belt: BeltVisualData;
  stripes: number;
  className?: string;
}

/**
 * REDESIGN_BRIEF.md Phase 3 "BeltBar": small inline bar for table
 * rows/lists — distinct from BeltGraphic's hero size (kiosk/portal
 * confirmation screens). Phase 3b: a thin `xs`-size wrapper around the
 * shared `BeltVisual` (spec: "Preserve existing display sizes through
 * wrappers"). "Always paired with text" per the brief, so this stays
 * `aria-hidden` — the caller's own text carries the accessible label
 * (e.g. "Azul · 2 franjas"), same as before.
 */
export function BeltBar({ belt, stripes, className }: BeltBarProps) {
  return (
    <span aria-hidden className={className}>
      <BeltVisual belt={belt} stripes={stripes} label="" size="xs" />
    </span>
  );
}
