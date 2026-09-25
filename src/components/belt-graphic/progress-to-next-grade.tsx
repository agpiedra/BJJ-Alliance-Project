import { cn } from "cn";

/**
 * A progressbar must have an accessible name, so the API requires exactly one of `aria-label` (a translated string the
 * caller builds, e.g. "Progress: Ana Verify") or `aria-labelledby` (the id of a heading that already names it). Passing
 * neither, or both, does not compile. An empty string is a caller bug the type cannot see; callers pass real copy.
 */
type ProgressName =
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-labelledby": string; "aria-label"?: never };

export type ProgressToNextGradeProps = {
  current: number;
  target: number;
  className?: string;
} & ProgressName;

/**
 * REDESIGN_BRIEF.md Phase 3: "5px track + fill + mono '41 / 65'. Fill turns
 * --accent at >= 90%." Purely presentational — the current/target numbers
 * come from computeBeltProgress (src/lib/students/eligibility.ts), which
 * this does not reimplement (Rule 8: don't touch business logic).
 */
export function ProgressToNextGrade({ current, target, className, ...naming }: ProgressToNextGradeProps) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const value = Math.min(current, target);
  const nearComplete = pct >= 90;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* MATROOM Phase 1: a real progressbar (value and range for assistive technology), a track edged with the >= 3:1
          control-boundary token, and a fill in the data colour (>= 3:1 on the track). Near completion the fill takes the
          tenant's colour through --brand-data, which BrandingScope lightness-adjusts to 3:1 per theme (the stored colour
          is never changed). The "20 / 60" text beside it stays the exact value. */}
      <div
        role="progressbar"
        aria-label={naming["aria-label"]}
        aria-labelledby={naming["aria-labelledby"]}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={value}
        aria-valuetext={`${value} / ${target}`}
        className="h-2 flex-1 overflow-hidden rounded-full border border-input bg-data-track"
      >
        <div
          data-fill
          className={cn("h-full rounded-full", nearComplete ? "bg-brand-data" : "bg-data")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {current} / {target}
      </span>
    </div>
  );
}
