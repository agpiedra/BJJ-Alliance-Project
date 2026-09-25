import { cn } from "cn";

export interface ProgressToNextGradeProps {
  current: number;
  target: number;
  className?: string;
}

/**
 * REDESIGN_BRIEF.md Phase 3: "5px track + fill + mono '41 / 65'. Fill turns
 * --accent at >= 90%." Purely presentational — the current/target numbers
 * come from computeBeltProgress (src/lib/students/eligibility.ts), which
 * this does not reimplement (Rule 8: don't touch business logic).
 */
export function ProgressToNextGrade({ current, target, className }: ProgressToNextGradeProps) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const nearComplete = pct >= 90;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* MATROOM Phase 1: a real progressbar (value and range for assistive technology), a track edged with the >= 3:1
          control-boundary token, and a fill in the data colour (>= 3:1 on the track). Near completion the fill takes the
          tenant's colour through --brand-data, which BrandingScope lightness-adjusts to 3:1 per theme (the stored colour
          is never changed). The "20 / 60" text beside it stays the exact value. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(current, target)}
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
