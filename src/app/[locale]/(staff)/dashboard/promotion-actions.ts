"use server";

import { z } from "zod";
import { resolveActionContext } from "@/lib/tenant/context";
import { awardPromotion } from "@/lib/promotion/award";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

const confirmPromotionSchema = z.object({
  studentId: z.string().min(1),
  notes: z.string().optional(),
});

/**
 * ADMIN/DIRECTOR only — spec §3 explicitly excludes INSTRUCTOR from
 * promotions (unlike `addAttendanceAdjustment`'s wider ADMIN/DIRECTOR/
 * INSTRUCTOR grant for attendance marking/correction).
 *
 * `studentId` is the only client-submitted field that drives the actual
 * promotion decision — an optional `notes` field is accepted and passed
 * through verbatim, but nothing else the client could submit (a `toBelt`/
 * `toStripes`, say) is ever trusted.
 *
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii: this is now a thin "use
 * server" wrapper — parse, authenticate, delegate. All the actual
 * eligibility recomputation, the concurrency/status guards, and the
 * transactional write live in `src/lib/promotion/award.ts`'s
 * `awardPromotion`, the spec's "centralized server-side award function"
 * that every entry point (this action today, Phase 2d's student-detail-page
 * card later) calls — never duplicated here.
 */
export async function confirmPromotion(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = confirmPromotionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const result = await awardPromotion(auth.context, parsed.data.studentId, parsed.data.notes ?? null);
  if (!result.ok) {
    return { error: result.error };
  }
  await refreshPromotionPages(parsed.data.studentId);
  return { ok: true };
}
