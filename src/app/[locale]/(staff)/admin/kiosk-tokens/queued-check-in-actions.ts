"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { dismissQueuedCheckIn, resolveQueuedCheckIn } from "@/lib/kiosk/queued-check-ins";
import type { ActionState } from "@/lib/action-state";

const resolveSchema = z.object({
  queuedCheckInId: z.string().min(1),
  classSessionId: z.string().min(1),
  // Validated as a real Costa Rica calendar day by the domain function; a blank one is `invalidDate`, not a crash.
  date: z.string().max(20),
  // The tap time the coach confirms (HH:mm, Costa Rica); required, validated by the domain function (`invalidTime`).
  time: z.string().max(20).default(""),
});

const dismissSchema = z.object({
  queuedCheckInId: z.string().min(1),
  reason: z.string().max(2000),
});

/**
 * The Kiosco page's "Queued check-ins awaiting review" -> "Record on that day" action.
 *
 * Gated ADMIN/DIRECTOR/INSTRUCTOR (a coach records what actually happened), like the Cambiar action beside it. Same
 * re-fetch-and-re-check discipline as every other write here: the evidence's real academy is read from the database and
 * checked against the caller's scope before anything is written; `resolveQueuedCheckIn` independently re-validates the
 * class, the day and the single-use claim. A student, or a member of another organization, gets `notFound`.
 */
export async function resolveQueuedCheckInAction(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = resolveSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "notFound" };

  const kept = await getScopedDb(context).queuedCheckIn.findUnique({ where: { id: parsed.data.queuedCheckInId }, select: { academyId: true } });
  if (!kept || !isAcademyInTenantScope(context, kept.academyId)) return { error: "notFound" };

  const result = await resolveQueuedCheckIn(parsed.data.queuedCheckInId, {
    classSessionId: parsed.data.classSessionId,
    date: parsed.data.date,
    time: parsed.data.time,
    actorUserId: context.actorUserId,
    context,
  });
  if (!result.ok) return { error: result.error };

  await refreshKioscoPage();
  return { ok: true };
}

/** "Set aside" - the evidence stays in the database with the reason, who and when. Same gate and scope checks. */
export async function dismissQueuedCheckInAction(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = dismissSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "notFound" };

  const kept = await getScopedDb(context).queuedCheckIn.findUnique({ where: { id: parsed.data.queuedCheckInId }, select: { academyId: true } });
  if (!kept || !isAcademyInTenantScope(context, kept.academyId)) return { error: "notFound" };

  const result = await dismissQueuedCheckIn(parsed.data.queuedCheckInId, { reason: parsed.data.reason, actorUserId: context.actorUserId, context });
  if (!result.ok) return { error: result.error };

  await refreshKioscoPage();
  return { ok: true };
}

/**
 * Best-effort, like every sibling action: `revalidatePath` needs a real Next.js request scope, which is absent when an
 * integration test calls the exported action directly. The write has already committed.
 */
async function refreshKioscoPage() {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/admin/kiosk-tokens`);
  } catch (error) {
    console.error("[queued-check-in] failed to revalidate", { error });
  }
}
