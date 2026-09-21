"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { Notification } from "@/generated/prisma/client";

// ADMIN/DIRECTOR/INSTRUCTOR only — matches the old `getStaffSession()`'s
// STAFF_ROLES list (STUDENT was never staff). Replaced in revision 23:
// `getStaffSession()`'s `academyIds` fed real cross-tenant query scoping
// with no organizationId anywhere, which `Notification` (organizationId
// NOT NULL) inherited via this file's raw `prisma.notification` calls.
const STAFF_ROLES = ["ADMIN", "DIRECTOR", "INSTRUCTOR"] as const;

// All three take the organization the CALLER names and re-verify the caller's
// membership in it (`resolveActionContext`), rather than trusting the session's
// ambient active organization. They are "use server" exports, so the client can
// call them directly — a non-member gets an empty answer / a no-op, a member
// without a staff role throws `FORBIDDEN`, like every other action.

/** The signed-in staff member's own 20 most recent notifications, newest first. */
export async function getMyNotifications(organizationId: string): Promise<Notification[]> {
  const auth = await resolveActionContext(organizationId, [...STAFF_ROLES]);
  if (!auth.ok) return [];
  const context = auth.context;
  return getScopedDb(context).notification.findMany({
    where: { userId: context.actorUserId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** The signed-in staff member's own unread count — for the bell's badge. */
export async function getUnreadCount(organizationId: string): Promise<number> {
  const auth = await resolveActionContext(organizationId, [...STAFF_ROLES]);
  if (!auth.ok) return 0;
  const context = auth.context;
  return getScopedDb(context).notification.count({ where: { userId: context.actorUserId, readAt: null } });
}

/**
 * Marks every currently-unread notification belonging to the CALLING
 * session as read (the plan's ruling: opening the bell's dropdown marks
 * everything currently listed as read — no per-item toggle). Always scoped
 * to `context.actorUserId`, server-side — never a client-submitted id, the
 * same discipline every mutation in this codebase applies to "whose data to
 * touch."
 */
export async function markAllRead(organizationId: string): Promise<void> {
  const auth = await resolveActionContext(organizationId, [...STAFF_ROLES]);
  if (!auth.ok) return;
  const context = auth.context;
  await getScopedDb(context).notification.updateMany({
    where: { userId: context.actorUserId, readAt: null },
    data: { readAt: new Date() },
  });
}
