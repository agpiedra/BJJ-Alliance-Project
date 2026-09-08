import { useTranslations } from "next-intl";

export type Belt = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";

const BELT_FILL: Record<Belt, string> = {
  WHITE: "#F5F5F0",
  BLUE: "#1D4ED8",
  PURPLE: "#7C3AED",
  BROWN: "#5C4033",
  BLACK: "#171717",
};

const BELT_BORDER: Record<Belt, string> = {
  WHITE: "#D4D4D4",
  BLUE: "#1E3A8A",
  PURPLE: "#5B21B6",
  BROWN: "#3F2A1D",
  BLACK: "#000000",
};

const BAR_FILL: Record<Belt, string> = {
  WHITE: "#171717",
  BLUE: "#171717",
  PURPLE: "#171717",
  BROWN: "#171717",
  BLACK: "#B91C1C",
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
          fill={BELT_FILL[belt]}
          stroke={BELT_BORDER[belt]}
          strokeWidth={2}
        />
        <rect x={130} y={1} width={69} height={58} fill={BAR_FILL[belt]} />
        {Array.from({ length: clampedStripes }, (_, index) => (
          <rect
            key={index}
            x={140 + index * 13}
            y={9}
            width={7}
            height={42}
            fill="#FFFFFF"
          />
        ))}
      </svg>
      <figcaption className="text-sm">{label}</figcaption>
    </figure>
  );
}
