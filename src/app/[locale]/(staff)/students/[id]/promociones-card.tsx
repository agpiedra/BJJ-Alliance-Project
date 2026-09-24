"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { BeltGraphic, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { awardFromStudentPage } from "./promotion-actions";
import { PromotionCorrectionForm, type RankOption } from "./promotion-correction-form";
import { TrackChangeForm, type TrackChangeRankOption } from "./track-change-form";
import type { ProgressView } from "@/lib/promotion/progress-view";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

export interface PromotionCreditHistoryRow {
  id: string;
  classesGranted: number;
  reason: string;
  grantedAtFormatted: string;
  grantedByName: string;
  active: boolean;
}

export interface PromocionesHistoryRow {
  id: string;
  /** Phase 3a rev 19: pre-resolved by the server page (which already has
   * the viewer's locale) from `BeltRank.labelEs`/`labelEn` — never a
   * `belt.<code>` message key. */
  fromBeltLabel: string;
  fromStripes: number;
  toBeltLabel: string;
  toStripes: number;
  awardedAtFormatted: string;
  awardedByName: string;
  source: "MANUAL" | "AUTO" | "CORRECTION" | "TRACK_CHANGE";
  notes: string | null;
}

export interface PromocionesCardProps {
  organizationId: string;
  studentId: string;
  belt: BeltVisualData;
  /** Pre-resolved display name (`BeltRank.labelEs`/`labelEn`), picked by the
   * page's own locale — this card never translates a code itself. */
  label: string;
  currentStripes: number;
  maxStripes: number;
  lifetimeCount: number;
  /**
   * The shared display shaping of the engine's result (`buildProgressView`) -
   * the same one every other surface reads. `dueDate` is passed pre-formatted
   * (`dueDateFormatted`), never as a Date.
   */
  view: Omit<ProgressView, "dueDate">;
  dueDateFormatted: string | null;
  /** The Costa Rica day the threshold was reached, already formatted for the viewer's locale; recalculated from current records on every render. */
  reachedOnFormatted: string | null;
  history: PromocionesHistoryRow[];
  creditHistory: PromotionCreditHistoryRow[];
  /** ADMIN/DIRECTOR — INSTRUCTOR/STUDENT get `false` and see everything above read-only, no buttons rendered at all (server rejects the call regardless). */
  canAct: boolean;
  rankOptions: RankOption[];
  /** Phase 3c-ii — scoped to the student's OTHER track (not their current
   * one); `null` for both when the org's catalog has no ranks configured
   * for that track at all. */
  trackChange: {
    rankOptions: TrackChangeRankOption[];
    defaultRankId: string | null;
    isTransition: boolean;
  } | null;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d — "Awarding from the student
 * detail page." An entry point, not a second system: the award button below
 * calls `awardFromStudentPage`, a thin wrapper around the SAME
 * `awardPromotion` the "Cola de promociones" dashboard button uses. No
 * client-side eligibility is ever treated as authoritative — `isEligible`
 * here is display-only; the server recomputes it fresh on every award
 * attempt.
 *
 * No optimistic UI (spec): the button shows a pending state and waits for
 * the server's real response before anything on screen changes. Next.js
 * revalidates the page's server data after a successful action, so a
 * completed award re-renders this whole card from fresh server state —
 * degree count, belt graphic, history row, and next target all follow from
 * that re-fetch, not from a client-side guess.
 */
export function PromocionesCard(props: PromocionesCardProps) {
  const t = useTranslations("students.detail.promociones");
  const tHistory = useTranslations("students.detail.promotionHistory");
  const tCredit = useTranslations("students.detail.creditHistory");
  const [state, formAction, isPending] = useActionState(
    awardFromStudentPage.bind(null, props.organizationId),
    INITIAL_STATE,
  );

  const { view } = props;
  const isEligible = view.state === "eligible";

  const nextTargetLabel = (() => {
    if (view.state === "manual") return t("nextTargetMANUAL");
    switch (view.nextTarget) {
      case "STRIPE":
        return t("nextTargetSTRIPE", { ordinal: props.currentStripes + 1 });
      case "BELT":
        return t("nextTargetBELT");
      default:
        return t("nextTargetNONE");
    }
  })();

  // Spec: "why the student is not eligible, when they aren't. Never a
  // disabled button with no explanation." One branch per display state, all
  // decided by the shared `buildProgressView` (never re-derived here).
  const progressLine = (() => {
    switch (view.state) {
      case "manual":
        return t("progressManual");
      case "eligible":
        // Full bar, zero remaining, and never an overflowing fraction: the real count is on its own line below.
        return t("eligibleNow");
      case "in_progress": {
        const attendanceLine = t("progressAttendance", {
          current: view.current ?? 0,
          target: view.target ?? 0,
          remaining: view.remaining ?? 0,
        });
        // HYBRID also shows its time dimension.
        return props.dueDateFormatted
          ? `${attendanceLine} · ${t("progressDueDate", { date: props.dueDateFormatted })}`
          : attendanceLine;
      }
      case "time_pending":
        return props.dueDateFormatted ? t("progressDueDate", { date: props.dueDateFormatted }) : null;
      case "time_anchor_missing":
        return t("lastPromotionDateNeeded");
      case "not_configured":
        return t("nextDegreeNotConfigured");
      default:
        return null;
    }
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-4">
          <BeltGraphic belt={props.belt} label={props.label} stripes={props.currentStripes} className="w-40" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{nextTargetLabel}</p>
            {progressLine && <p className="text-sm text-muted-foreground">{progressLine}</p>}
            {props.reachedOnFormatted && (
              <p className="text-sm text-muted-foreground">{t("reachedOn", { date: props.reachedOnFormatted })}</p>
            )}
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("atBeltCount")}</dt>
              <dd>{view.actualCount}</dd>
              <dt className="text-muted-foreground">{t("lifetimeCount")}</dt>
              <dd>{props.lifetimeCount}</dd>
            </dl>
          </div>
        </div>

        {props.canAct ? (
          <form action={formAction} className="flex flex-col items-start gap-2">
            <input type="hidden" name="studentId" value={props.studentId} />
            {state.ok && <p className="text-sm text-green-700">{t("award.success")}</p>}
            {state.error && (
              <p className="text-sm text-red-600">
                {t.has(`award.error.${state.error}`) ? t(`award.error.${state.error}` as never) : t("award.error.generic")}
              </p>
            )}
            <Button
              type="submit"
              disabled={isPending || !isEligible}
              onClick={(event) => {
                if (!window.confirm(t("award.confirm"))) {
                  event.preventDefault();
                }
              }}
            >
              {t("award.button")}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t("readOnlyNote")}</p>
        )}

        {props.canAct && (
          <PromotionCorrectionForm
            organizationId={props.organizationId}
            studentId={props.studentId}
            rankOptions={props.rankOptions}
          />
        )}

        {props.canAct && props.trackChange && (
          <TrackChangeForm
            organizationId={props.organizationId}
            studentId={props.studentId}
            rankOptions={props.trackChange.rankOptions}
            defaultRankId={props.trackChange.defaultRankId}
            isTransition={props.trackChange.isTransition}
          />
        )}

        {props.creditHistory.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium">{tCredit("heading")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{tCredit("columnDate")}</th>
                    <th className="pb-2 pr-4 font-medium">{tCredit("columnClasses")}</th>
                    <th className="pb-2 pr-4 font-medium">{tCredit("columnBy")}</th>
                    <th className="pb-2 pr-4 font-medium">{tCredit("columnStatus")}</th>
                    <th className="pb-2 font-medium">{tCredit("columnReason")}</th>
                  </tr>
                </thead>
                <tbody>
                  {props.creditHistory.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{row.grantedAtFormatted}</td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{row.classesGranted}</td>
                      <td className="py-2 pr-4 align-top">{row.grantedByName}</td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant="outline">{tCredit(row.active ? "statusActive" : "statusOutOfScope")}</Badge>
                      </td>
                      <td className="py-2 align-top whitespace-pre-wrap">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-sm font-medium">{tHistory("heading")}</h3>
          {props.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tHistory("empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{tHistory("columnDate")}</th>
                    <th className="pb-2 pr-4 font-medium">{tHistory("columnChange")}</th>
                    <th className="pb-2 pr-4 font-medium">{tHistory("columnBy")}</th>
                    <th className="pb-2 pr-4 font-medium">{tHistory("columnSource")}</th>
                    <th className="pb-2 font-medium">{tHistory("columnNotes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {props.history.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{row.awardedAtFormatted}</td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {row.fromBeltLabel} {row.fromStripes} → {row.toBeltLabel} {row.toStripes}
                      </td>
                      <td className="py-2 pr-4 align-top">{row.awardedByName}</td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant="outline">{tHistory(`source${row.source}` as "sourceMANUAL")}</Badge>
                      </td>
                      <td className="py-2 align-top whitespace-pre-wrap">{row.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
