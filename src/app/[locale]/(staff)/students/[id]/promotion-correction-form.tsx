"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { correctPromotionAction } from "./promotion-actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

export interface RankOption {
  id: string;
  code: string;
  order: number;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d — "Manual corrections."
 * ADMIN/DIRECTOR only (enforced server-side in `correctPromotionAction` ->
 * `correctPromotion`; this form is simply never rendered for any other
 * role — see `promociones-card.tsx`'s `canAct` gate). Bypasses eligibility
 * by design: this is for promoting early or fixing a mistaken entry, not
 * "confirm what the engine already computed."
 *
 * Anchor fields are genuinely optional and default to nothing, not "now" —
 * `promotion-actions.ts`'s `correctPromotionAction` only forwards them when
 * the staff member actually typed a value, per spec: "do not infer them
 * silently."
 */
export function PromotionCorrectionForm({
  organizationId,
  studentId,
  rankOptions,
}: {
  organizationId: string;
  studentId: string;
  rankOptions: RankOption[];
}) {
  const t = useTranslations("students.detail.promociones.correction");
  const [state, formAction, isPending] = useActionState(
    correctPromotionAction.bind(null, organizationId),
    INITIAL_STATE,
  );

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>
      <form action={formAction} className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="studentId" value={studentId} />
        <p className="text-sm text-muted-foreground">{t("warning")}</p>

        <label className="flex flex-col gap-1 text-sm">
          {t("rank")}
          <select name="toRankId" required className="rounded border px-2 py-1">
            {rankOptions
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((rank) => (
                <option key={rank.id} value={rank.id}>
                  {rank.code}
                </option>
              ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("stripes")}
          <input type="number" name="toStripes" min={0} required className="rounded border px-2 py-1" />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("beltAwardedAt")}
          <input type="date" name="beltAwardedAt" className="rounded border px-2 py-1" />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("timeAnchorAt")}
          <input type="date" name="timeAnchorAt" className="rounded border px-2 py-1" />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="clearTimeAnchor" />
          {t("clearTimeAnchor")}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("note")}
          <textarea name="note" required minLength={1} className="rounded border px-2 py-1" rows={2} />
        </label>

        {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
        {state.error === "invalid" && <p className="text-sm text-red-600">{t("invalid")}</p>}
        {state.error && state.error !== "invalid" && (
          <p className="text-sm text-red-600">
            {t.has(`error.${state.error}`) ? t(`error.${state.error}` as never) : t("error.generic")}
          </p>
        )}

        <Button type="submit" disabled={isPending} size="sm">
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
