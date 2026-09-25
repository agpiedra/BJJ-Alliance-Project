import { CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { BeltVisual } from "@/components/belt-graphic/belt-graphic";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProgressView } from "@/lib/promotion/progress-view";
import type { AtBeltSummary } from "@/lib/students/attendance-summary";

/**
 * The student's promotion progress, one display for both accounting modes (the numbers come from the shared engine via
 * `buildProgressView`: an eligible student sees a full bar and "eligible for instructor review", never 42 / 30, and nothing here
 * awards anything).
 *
 * What is said depends on WHAT DECIDES eligibility for the student's rank. An attendance count is shown only when there is an
 * attendance target (`view.current !== null`: attendance and hybrid ranks). For a time-based degree (black belt) eligibility is
 * decided by time since the last award, so the card shows the due date (or that the date is needed) and the lifetime total as a
 * plain fact, and never a line like "N attendances counted toward your next promotion", which would imply attendance decides it.
 */
export function ProgressCard({
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
    <Card data-testid="portal-progress">
      <CardHeader className="border-b">
        <CardTitle>{t("progress.heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-col items-start gap-2">
          <BeltVisual belt={summary.currentBeltVisual} stripes={summary.currentStripes} label={`${beltLabel}, ${stripes}`} size="lg" className="h-auto w-full max-w-[280px]" />
          <span className="text-sm font-medium">
            {beltLabel} · {stripes}
          </span>
          {hasAttendanceTarget && (
            <ProgressToNextGrade aria-label={t("progress.heading")} current={view.current as number} target={view.target as number} className="w-full" />
          )}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          {hasAttendanceTarget && <p>{t("progress.atBeltCount", { count: view.actualCount })}</p>}

          {view.state === "in_progress" && <p className="text-muted-foreground">{t("progress.remainingToNextStripe", { count: view.remaining ?? 0 })}</p>}

          {/* Eligible always means ready for instructor review, never an automatic award. */}
          {view.state === "eligible" && (
            <p className="flex items-start gap-2 font-medium">
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ok" />
              <span>{t("progress.eligibleForReview")}</span>
            </p>
          )}

          {view.state === "time_pending" && dueDateLabel && <p className="text-muted-foreground">{t("progress.timePending", { date: dueDateLabel })}</p>}
          {view.state === "time_anchor_missing" && <p className="text-muted-foreground">{t("progress.timeAnchorMissing")}</p>}
          {view.state === "not_configured" && <p className="text-muted-foreground">{t("progress.notConfigured")}</p>}

          <p className="text-muted-foreground">{t("progress.lifetimeCount", { count: summary.lifetimeCount })}</p>
        </div>
      </CardContent>
    </Card>
  );
}
