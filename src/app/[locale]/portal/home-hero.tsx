import { CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { BeltVisual } from "@/components/belt-graphic/belt-graphic";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";
import type { ProgressView } from "@/lib/promotion/progress-view";
import type { AtBeltSummary } from "@/lib/students/attendance-summary";

/**
 * Portal Home's page-level belt hero. Same belt/progress facts `ProgressCard` shows — same `buildProgressView`
 * data, nothing recomputed here — in a prominent top-of-page treatment instead of a bordered card. Deliberately
 * NOT a shared component with `ProgressCard`: Attendance's side panel still renders the bordered-card version
 * unchanged (`page.tsx`'s `attendance` block), so this file only ever affects Home.
 */
export function HomeHero({
  locale,
  summary,
  view,
  dueDateLabel,
}: {
  locale: string;
  summary: Pick<AtBeltSummary, "currentBeltVisual" | "currentStripes" | "currentBeltLabelEn" | "currentBeltLabelEs" | "lifetimeCount">;
  view: ProgressView;
  /** The due date already formatted in the academy's zone (null when there is none). */
  dueDateLabel: string | null;
}) {
  const t = useTranslations("portal");
  const tStudents = useTranslations("students");
  const beltLabel = locale === "es" ? summary.currentBeltLabelEs : summary.currentBeltLabelEn;
  const stripes = tStudents("beltStripes", { count: summary.currentStripes });
  const hasAttendanceTarget = view.current !== null && view.target !== null;

  return (
    <div
      data-testid="portal-home-hero"
      className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-6 text-center sm:flex-row sm:items-center sm:gap-6 sm:text-left"
    >
      <BeltVisual
        belt={summary.currentBeltVisual}
        stripes={summary.currentStripes}
        label={`${beltLabel}, ${stripes}`}
        size="lg"
        className="h-auto w-full max-w-[220px] sm:w-[220px]"
      />
      <div className="flex flex-1 flex-col items-center gap-2 sm:items-start">
        <p className="text-lg font-semibold">
          {beltLabel} · {stripes}
        </p>
        {hasAttendanceTarget && (
          <ProgressToNextGrade aria-label={t("progress.heading")} current={view.current as number} target={view.target as number} className="w-full max-w-sm" />
        )}
        <div className="flex flex-col gap-1 text-sm">
          {hasAttendanceTarget && <p>{t("progress.atBeltCount", { count: view.actualCount })}</p>}

          {view.state === "in_progress" && <p className="text-muted-foreground">{t("progress.remainingToNextStripe", { count: view.remaining ?? 0 })}</p>}

          {/* Eligible always means ready for instructor review, never an automatic award. */}
          {view.state === "eligible" && (
            <p className="flex items-center gap-2 font-medium">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
              <span>{t("progress.eligibleForReview")}</span>
            </p>
          )}

          {view.state === "time_pending" && dueDateLabel && <p className="text-muted-foreground">{t("progress.timePending", { date: dueDateLabel })}</p>}
          {view.state === "time_anchor_missing" && <p className="text-muted-foreground">{t("progress.timeAnchorMissing")}</p>}
          {view.state === "not_configured" && <p className="text-muted-foreground">{t("progress.notConfigured")}</p>}

          <p className="text-muted-foreground">{t("progress.lifetimeCount", { count: summary.lifetimeCount })}</p>
        </div>
      </div>
    </div>
  );
}
