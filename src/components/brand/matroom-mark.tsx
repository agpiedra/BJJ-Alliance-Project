import { cn } from "cn";
import { PLATFORM_NAME } from "@/lib/platform";

/**
 * The MATROOM mark: two rules skewed -12 degrees, the edges of a mat. This is the geometry of the approved landing
 * reference's CSS mark (a 24px box with 2px top and bottom borders, skewY(-12deg)) redrawn as SVG so it scales cleanly;
 * the reference shipped no logo file, so this is a faithful reproduction, not a new logo (design/matroom/DESIGN.md
 * "Identity"). It draws in `currentColor`, so it takes the surrounding text colour on any theme or tenant surface.
 *
 * Decorative: the platform name is always present as text next to it, so the mark is hidden from assistive technology.
 * Minimum size 16px wide; on its own (an app icon) it sits on a --primary tile (public/icon-*.png, src/app/icon.png).
 */
const RULES = [
  "0,2.55 24,-2.55 24,-0.55 0,4.55", // top rule: y 0..2, skewed about the centre (tan 12deg = 0.2126)
  "0,24.55 24,19.45 24,21.45 0,26.55", // bottom rule: y 22..24
] as const;

export function MatroomMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn("shrink-0", className)}
      width={size}
      height={(size * 30) / 24}
      viewBox="0 -3 24 30"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {RULES.map((points) => (
        <polygon key={points} points={points} />
      ))}
    </svg>
  );
}

/** The mark with the platform name set in IBM Plex Sans semibold, uppercase, -0.02em. `size` is the text size in px. */
export function MatroomWordmark({ size = 19, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-[0.55em] font-semibold tracking-[-0.02em] whitespace-nowrap uppercase", className)}
      style={{ fontSize: size, lineHeight: 1 }}
    >
      <MatroomMark size={Math.round(size * 1.05)} />
      {PLATFORM_NAME}
    </span>
  );
}
