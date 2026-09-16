"use client";

import { useId } from "react";
import { visibleTapes, type TapeRank } from "@/lib/belt-display";

export type BeltSize = "xs" | "sm" | "lg";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b — the real per-rank color data
 * (BeltRank.primaryColor/centerStripeColor/barColor), replacing the old
 * hardcoded adult-only BELT_FILL_CLASS/TIP_FILL_CLASS Tailwind-token maps.
 * A caller builds this directly from a loaded BeltRank row.
 */
export interface BeltVisualData extends TapeRank {
  primaryColor: string;
  /** Revision 21: a nullable centre-stripe color, not isSplit + splitColor —
   * the belt is its own color with a contrasting band down the middle
   * third of its height, never two colored halves. */
  centerStripeColor: string | null;
  barColor: string;
}

const VIEW_W = 360;
const VIEW_H = 40;
const SIZE_WIDTH: Record<BeltSize, number> = { xs: 64, sm: 140, lg: 320 };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * Stitch color derived FROM the belt color, never a fixed stroke (spec:
 * "not black, not a fixed gray — derive it from the belt color"). Mixes
 * toward whichever end (white/black) is farther from the source, then
 * keeps widening that mix until the luminance gap clears a minimum floor —
 * a straight 35% mix left saturated mid-tones (green) with almost no
 * visible stitching, since lightening within the same hue family doesn't
 * guarantee contrast the way it does for a genuinely light or dark color.
 */
const MIN_STITCH_CONTRAST = 70;

function stitchColorFor(hex: string): string {
  const rgb = hexToRgb(hex);
  const srcLum = luminance(rgb);
  const target = srcLum < 128 ? 255 : 0;
  const mixAt = (amount: number): [number, number, number] =>
    rgb.map((c) => c + (target - c) * amount) as [number, number, number];

  let amount = 0.35;
  let mixed = mixAt(amount);
  while (Math.abs(luminance(mixed) - srcLum) < MIN_STITCH_CONTRAST && amount < 0.9) {
    amount += 0.1;
    mixed = mixAt(amount);
  }
  const [r, g, b] = mixed.map((c) => Math.round(Math.max(0, Math.min(255, c))));
  return `rgba(${r}, ${g}, ${b}, 0.6)`;
}

/** A thin contrasting outline for a tape, so it stays visible on any bar
 * color — picked against the tape's own fill, not the bar, so a white tape
 * keeps a dark ring and a red tape keeps a light one regardless of what's
 * behind it. */
function tapeOutlineFor(hex: string): string {
  return luminance(hexToRgb(hex)) < 128 ? "rgba(255, 255, 255, 0.7)" : "rgba(0, 0, 0, 0.55)";
}

/** Centre stripe (revision 21): a contrasting band through the middle
 * third of the belt's height, not two colored halves. Stitching rows must
 * sit above and below this band, never cross it. */
const BAND_TOP = 1 / 3;
const BAND_BOTTOM = 2 / 3;

export interface BeltGraphicProps {
  belt: BeltVisualData;
  stripes: number;
  /** The already-resolved display name (`BeltRank.labelEs`/`labelEn`,
   * picked by the caller's own locale) — this component never translates a
   * code itself (spec rev 19: labels are per-organization data). */
  label: string;
  size?: BeltSize;
  className?: string;
}

/**
 * The shared realistic-belt SVG — a woven strip, longitudinal stitching,
 * a rank bar inset from the tip with a belt-colored tail beyond it, and
 * tapes on the bar. `BeltGraphic` (the hero size) and `BeltBar` (the
 * compact list-row size) are both thin wrappers around this, per spec:
 * "Extend the existing BeltGraphic and BeltBar components around one
 * shared visible-tapes derivation function... Preserve existing display
 * sizes through wrappers."
 *
 * Size variants degrade gracefully (spec): `xs` drops the weave texture,
 * the depth shadow, and runs 2 stitch rows instead of 3 — sub-pixel detail
 * at list-row scale turns into mud and costs render time for no visual
 * gain.
 *
 * `useId()` on every def (clip path, weave pattern, depth gradient) so
 * many instances on one page (a roster of 50) never collide — a hardcoded
 * id would make every row's fill silently follow the FIRST row's.
 */
function BeltVisual({ belt, stripes, label, size = "lg", className }: BeltGraphicProps) {
  const clipId = useId();
  const weaveId = useId();
  const edgeId = useId();

  const width = SIZE_WIDTH[size];
  const height = width / (VIEW_W / VIEW_H);
  const showWeave = size !== "xs";
  const showDepth = size !== "xs";
  const allStitchRows = size === "xs" ? [0.33, 0.67] : [0.25, 0.5, 0.75];
  const stitchRows = belt.centerStripeColor
    ? allStitchRows.filter((fraction) => fraction <= BAND_TOP || fraction >= BAND_BOTTOM)
    : allStitchRows;

  // Rank bar: inset from the tip (right edge) so a tail of belt color
  // remains beyond it (~9% of length); bar itself ~19% of length —
  // proportions confirmed against a real belt during Step 1's checkpoint.
  const tail = VIEW_W * 0.09;
  const barWidth = VIEW_W * 0.19;
  const barRight = VIEW_W - tail;
  const barLeft = barRight - barWidth;

  const clampedStripes = Math.max(0, Math.min(belt.maxStripes, Math.round(stripes)));
  const tapes = visibleTapes(belt, clampedStripes);
  const tapePad = barWidth * 0.07;
  const tapeSlotWidth = (barWidth - tapePad * 2) / belt.visibleStripeSlots;
  const tapeWidth = tapeSlotWidth * 0.55;

  const stitchColor = stitchColorFor(belt.primaryColor);
  const barStitchColor = stitchColorFor(belt.barColor);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className={className}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={1} y={1} width={VIEW_W - 2} height={VIEW_H - 2} rx={6} />
        </clipPath>
        {showWeave && (
          <pattern id={weaveId} width={3} height={VIEW_H} patternUnits="userSpaceOnUse">
            <line x1={0} y1={0} x2={0} y2={VIEW_H} stroke="#000000" strokeOpacity={0.05} strokeWidth={1} />
          </pattern>
        )}
        {showDepth && (
          <linearGradient id={edgeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000000" stopOpacity="0.14" />
            <stop offset="0.18" stopColor="#000000" stopOpacity="0" />
            <stop offset="0.82" stopColor="#000000" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.14" />
          </linearGradient>
        )}
      </defs>

      {/* Split and solid belts share ONE silhouette (a single rounded rect
          used as a clip path) so the corners are identical either way. */}
      <g clipPath={`url(#${clipId})`}>
        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill={belt.primaryColor} />
        {belt.centerStripeColor && (
          <rect
            x={0}
            y={VIEW_H * BAND_TOP}
            width={VIEW_W}
            height={VIEW_H * (BAND_BOTTOM - BAND_TOP)}
            fill={belt.centerStripeColor}
          />
        )}
        {showWeave && <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill={`url(#${weaveId})`} />}

        {/* Three (two at xs) tight rows of short dashes — a single line
            down the centre reads as a divider, not stitching. On a
            centre-striped belt, rows inside the band are dropped so
            stitching sits above and below the band rather than crossing
            it (revision 21). */}
        {stitchRows.map((fraction) => (
          <line
            key={fraction}
            x1={10}
            y1={VIEW_H * fraction}
            x2={VIEW_W - 10}
            y2={VIEW_H * fraction}
            stroke={stitchColor}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}

        {showDepth && <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill={`url(#${edgeId})`} />}
      </g>
      {/* Border derived from the belt's OWN color (spec: "self-contained on
          any surface... a thin border derived from its own color rather
          than relying on the page") — never a page theme token, so a white
          belt stays visible on a white card and a black belt on a dark
          sidebar without depending on where it's rendered. */}
      <rect x={1} y={1} width={VIEW_W - 2} height={VIEW_H - 2} rx={6} fill="none" stroke={stitchColor} />

      {/* Rank bar, inset from the tip with a tail beyond it, stitched
          along its own leading edge where it's sewn on. */}
      <rect x={barLeft} y={1} width={barWidth} height={VIEW_H - 2} fill={belt.barColor} />
      {showDepth && (
        <line x1={barLeft} y1={4} x2={barLeft} y2={VIEW_H - 4} stroke={barStitchColor} strokeWidth={1} strokeDasharray="2 2" />
      )}

      {tapes.map((color, i) => (
        <rect
          key={i}
          x={barLeft + tapePad + i * tapeSlotWidth}
          y={5}
          width={tapeWidth}
          height={VIEW_H - 10}
          fill={color}
          stroke={tapeOutlineFor(color)}
          strokeWidth={0.75}
        />
      ))}
    </svg>
  );
}

/** The hero-size belt graphic (student profile, kiosk/portal confirmation
 * screens) — a figure with a visible caption underneath. */
export function BeltGraphic(props: BeltGraphicProps) {
  return (
    <figure className="flex flex-col gap-1">
      <BeltVisual {...props} size={props.size ?? "lg"} className={undefined} />
      <figcaption className={props.className ?? "text-sm"}>{props.label}</figcaption>
    </figure>
  );
}

export { BeltVisual };
