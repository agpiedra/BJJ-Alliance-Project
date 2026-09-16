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
      <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", nearComplete ? "bg-brand-gold" : "bg-foreground/40")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {current} / {target}
      </span>
    </div>
  );
}
