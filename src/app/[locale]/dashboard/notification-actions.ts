"use server";

import { prisma } from "@/lib/prisma";
import { requireStaffSession } from "@/lib/auth/session";
import type { Notification } from "@/generated/prisma/client";

/** The signed-in staff member's own 20 most recent notifications, newest first. */
export async function getMyNotifications(): Promise<Notification[]> {
  const session = await requireStaffSession();
  return prisma.notification.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** The signed-in staff member's own unread count — for the bell's badge. */
export async function getUnreadCount(): Promise<number> {
  const session = await requireStaffSession();
  return prisma.notification.count({ where: { userId: session.userId, readAt: null } });
}

/**
 * Marks every currently-unread notification belonging to the CALLING
 * session as read (the plan's ruling: opening the bell's dropdown marks
 * everything currently listed as read — no per-item toggle). Always scoped
 * to `session.userId`, server-side — never a client-submitted id, the same
 * discipline every mutation in this codebase applies to "whose data to
 * touch."
 */
export async function markAllRead(): Promise<void> {
  const session = await requireStaffSession();
  await prisma.notification.updateMany({
    where: { userId: session.userId, readAt: null },
    data: { readAt: new Date() },
  });
}
