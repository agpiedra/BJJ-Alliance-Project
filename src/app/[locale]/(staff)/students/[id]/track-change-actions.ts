"use server";

import { z } from "zod";
import { resolveActionContext } from "@/lib/tenant/context";
import { changeTrack } from "@/lib/promotion/track-change";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

const trackChangeSchema = z.object({
  studentId: z.string().min(1),
  toRankId: z.string().min(1),
  toStripes: z.coerce.number().int().min(0),
  note: z.string().optional(),
});

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-ii: thin "use server" wrapper
 * around `changeTrack`, same shape as `promotion-actions.ts`'s
 * `correctPromotionAction` — parses input, authenticates, delegates. The
 * destination track itself is never part of the form: `changeTrack` always
 * derives it as "the other one" from the student's current track, read
 * fresh from the database, never from anything this action forwards.
 */
export async function changeTrackAction(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = trackChangeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const result = await changeTrack(auth.context, {
    studentId: data.studentId,
    toRankId: data.toRankId,
    toStripes: data.toStripes,
    note: data.note?.trim() ? data.note.trim() : null,
  });
  if (!result.ok) {
    return { error: result.error };
  }
  await refreshPromotionPages(data.studentId);
  return { ok: true };
}
