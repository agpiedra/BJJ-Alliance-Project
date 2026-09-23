"use server";

import { z } from "zod";
import { resolveActionContext } from "@/lib/tenant/context";
import { awardPromotion } from "@/lib/promotion/award";
import { correctPromotion } from "@/lib/promotion/correction";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

const awardSchema = z.object({ studentId: z.string().min(1) });

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d: the student-detail-page
 * Promociones card's "regular award" button. A thin "use server" wrapper —
 * same shape as `dashboard/promotion-actions.ts`'s `confirmPromotion` — that
 * delegates to the SAME `awardPromotion` the queue uses. No second
 * implementation: this file only parses input, authenticates, and calls the
 * shared function.
 */
export async function awardFromStudentPage(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = awardSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const result = await awardPromotion(auth.context, parsed.data.studentId, null);
  if (!result.ok) {
    return { error: result.error };
  }
  await refreshPromotionPages(parsed.data.studentId);
  return { ok: true };
}

/**
 * Date-only inputs (`<input type="date">`) arrive as `YYYY-MM-DD` with no
 * time component — anchored to noon UTC so a timezone shift can never roll
 * it to the adjacent calendar day, same convention as
 * `promotion-config.test.ts`'s own fixture dates.
 */
function dateOnlyToUtcNoon(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

const correctionSchema = z.object({
  studentId: z.string().min(1),
  toRankId: z.string().min(1),
  toStripes: z.coerce.number().int().min(0),
  beltAwardedAt: z.string().optional(),
  timeAnchorAt: z.string().optional(),
  clearTimeAnchor: z.string().optional(),
  note: z.string().min(1, "noteRequired"),
});

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d: manual promote/correct.
 * Deliberately NOT `awardPromotion` — see `correction.ts`'s own doc comment
 * for why a correction is a genuinely different operation (explicit
 * override, never eligibility-gated) sharing only the transactional writer.
 * `beltAwardedAt`/`timeAnchorAt` are OMITTED from the parsed input (not sent
 * as empty strings) when the staff member leaves those fields blank — never
 * silently inferred as "now," per the spec's own explicit rule.
 */
export async function correctPromotionAction(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = correctionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const result = await correctPromotion(auth.context, {
    studentId: data.studentId,
    toRankId: data.toRankId,
    toStripes: data.toStripes,
    beltAwardedAt: data.beltAwardedAt ? dateOnlyToUtcNoon(data.beltAwardedAt) : undefined,
    timeAnchorAt:
      data.clearTimeAnchor === "on" ? null : data.timeAnchorAt ? dateOnlyToUtcNoon(data.timeAnchorAt) : undefined,
    note: data.note,
  });
  if (!result.ok) {
    return { error: result.error };
  }
  await refreshPromotionPages(data.studentId);
  return { ok: true };
}
