import { useTranslations } from "next-intl";
import { cn } from "cn";

export type Belt = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";

// REDESIGN_BRIEF.md Phase 3: was raw hex per belt (Rule 1 violation from
// before this brief existed) — now the Phase 1 belt-* tokens via Tailwind's
// auto-generated fill-* utilities. Tip is belt-black for every belt except
// BLACK itself, which gets a red tip per the brief's literal BeltBar spec
// ("black tip (red tip for black belt)") — reusing --bad's red swatch for
// this decorative belt-iconography detail, not asserting a status meaning.
// Per-belt border hex isn't part of the new spec; a single generic border
// token replaces the old bespoke per-belt outline shades.
// Exported so belt-bar.tsx (Phase 3's small inline variant) reuses the same
// belt->token mapping instead of duplicating it.
export const BELT_FILL_CLASS: Record<Belt, string> = {
  WHITE: "fill-belt-white",
  BLUE: "fill-belt-blue",
  PURPLE: "fill-belt-purple",
  BROWN: "fill-belt-brown",
  BLACK: "fill-belt-black",
};

export const TIP_FILL_CLASS: Record<Belt, string> = {
  WHITE: "fill-belt-black",
  BLUE: "fill-belt-black",
  PURPLE: "fill-belt-black",
  BROWN: "fill-belt-black",
  BLACK: "fill-bad",
};

export interface BeltGraphicProps {
  belt: Belt;
  stripes: number;
  /**
   * Per-belt stripe ceiling. Defaults to 4 for callers that have no
   * BeltRequirement row on hand; real limits live in data (BeltRequirement
   * .maxStripes — BLACK is 0), never hardcoded here.
   */
  maxStripes?: number;
  className?: string;
}

export function BeltGraphic({ belt, stripes, maxStripes = 4, className }: BeltGraphicProps) {
  const t = useTranslations("belt");
  const tGraphic = useTranslations("beltGraphic");

  const clampedStripes = Math.max(0, Math.min(maxStripes, Math.round(stripes)));
  const beltName = t(belt);
  const label = tGraphic("label", { belt: beltName, stripes: clampedStripes });

  return (
    <figure className={className}>
      <svg
        viewBox="0 0 200 60"
        width={200}
        height={60}
        role="img"
        aria-label={label}
      >
        <rect
          x={1}
          y={1}
          width={198}
          height={58}
          rx={6}
          className={cn(BELT_FILL_CLASS[belt], "stroke-border")}
          strokeWidth={2}
        />
        <rect x={130} y={1} width={69} height={58} className={TIP_FILL_CLASS[belt]} />
        {Array.from({ length: clampedStripes }, (_, index) => (
          <rect
            key={index}
            x={140 + index * 13}
            y={9}
            width={7}
            height={42}
            className="fill-belt-white"
          />
        ))}
      </svg>
      <figcaption className="text-sm">{label}</figcaption>
    </figure>
  );
}
