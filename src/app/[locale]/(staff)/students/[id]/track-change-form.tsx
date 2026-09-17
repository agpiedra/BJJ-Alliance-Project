"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { changeTrackAction } from "./track-change-actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

export interface TrackChangeRankOption {
  id: string;
  code: string;
  order: number;
  maxStripes: number;
  labelEs: string;
  labelEn: string;
}

function stripeRange(maxStripes: number): number[] {
  return Array.from({ length: maxStripes + 1 }, (_, i) => i);
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-ii: the explicit track-change
 * flow. `rankOptions` is already scoped to the destination track (the page
 * computes "the other track" and fetches only its ranks) — this component
 * never sees or picks a track itself.
 *
 * `defaultRankId` is set by the page ONLY when the student's current rank
 * is exactly `green_black` (kids track ending, adult blue is the correct
 * default) — every other kids rank gets `null`, which this form renders as
 * a blank, unselected first option, forcing the operator to actually choose
 * rather than silently landing on whatever the destination track's own
 * first rank happens to be.
 *
 * `isTransition` swaps the toggle's copy to "Transición a adulto" when the
 * student is old enough (spec: "surface a 'Transición a adulto' action" at
 * 16) — same form, same submit path, just the more specific, more
 * discoverable label for that milestone. Nothing here fires automatically;
 * a human still opens the toggle and submits.
 */
export function TrackChangeForm({
  organizationId,
  studentId,
  rankOptions,
  defaultRankId,
  isTransition,
}: {
  organizationId: string;
  studentId: string;
  rankOptions: TrackChangeRankOption[];
  defaultRankId: string | null;
  isTransition: boolean;
}) {
  const t = useTranslations("students.detail.promociones.trackChange");
  const locale = useLocale();
  const [state, formAction, isPending] = useActionState(
    changeTrackAction.bind(null, organizationId),
    INITIAL_STATE,
  );

  const sortedRanks = rankOptions.slice().sort((a, b) => a.order - b.order);
  const [rankId, setRankId] = useState(defaultRankId ?? "");
  const [stripes, setStripes] = useState(0);
  const selectedRank = sortedRanks.find((r) => r.id === rankId);

  function handleRankChange(nextRankId: string) {
    setRankId(nextRankId);
    setStripes(0);
  }

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{isTransition ? t("transitionToggle") : t("toggle")}</summary>
      <form action={formAction} className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="studentId" value={studentId} />
        <p className="text-sm text-muted-foreground">{t("warning")}</p>

        <label className="flex flex-col gap-1 text-sm">
          {t("rank")}
          <select
            name="toRankId"
            required
            value={rankId}
            onChange={(event) => handleRankChange(event.target.value)}
            className="rounded border px-2 py-1"
          >
            <option value="" disabled>
              {t("rankPlaceholder")}
            </option>
            {sortedRanks.map((rank) => (
              <option key={rank.id} value={rank.id}>
                {locale === "es" ? rank.labelEs : rank.labelEn}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("stripes")}
          <select
            name="toStripes"
            required
            value={stripes}
            onChange={(event) => setStripes(Number(event.target.value))}
            className="rounded border px-2 py-1"
          >
            {stripeRange(selectedRank?.maxStripes ?? 0).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("note")}
          <textarea name="note" className="rounded border px-2 py-1" rows={2} />
        </label>

        {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
        {state.error && (
          <p className="text-sm text-red-600">
            {t.has(`error.${state.error}`) ? t(`error.${state.error}` as never) : t("error.generic")}
          </p>
        )}

        <Button type="submit" disabled={isPending || !rankId} size="sm">
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
