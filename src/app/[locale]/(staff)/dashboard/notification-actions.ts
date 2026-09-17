"use server";

import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { Notification } from "@/generated/prisma/client";

// ADMIN/DIRECTOR/INSTRUCTOR only — matches the old `getStaffSession()`'s
// STAFF_ROLES list (STUDENT was never staff). Replaced in revision 23:
// `getStaffSession()`'s `academyIds` fed real cross-tenant query scoping
// with no organizationId anywhere, which `Notification` (organizationId
// NOT NULL) inherited via this file's raw `prisma.notification` calls.
const STAFF_ROLES = ["ADMIN", "DIRECTOR", "INSTRUCTOR"] as const;

/** The signed-in staff member's own 20 most recent notifications, newest first. */
export async function getMyNotifications(): Promise<Notification[]> {
  const context = await requireTenantContext([...STAFF_ROLES]);
  return getScopedDb(context).notification.findMany({
    where: { userId: context.actorUserId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** The signed-in staff member's own unread count — for the bell's badge. */
export async function getUnreadCount(): Promise<number> {
  const context = await requireTenantContext([...STAFF_ROLES]);
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
export async function markAllRead(): Promise<void> {
  const context = await requireTenantContext([...STAFF_ROLES]);
  await getScopedDb(context).notification.updateMany({
    where: { userId: context.actorUserId, readAt: null },
    data: { readAt: new Date() },
  });
}
