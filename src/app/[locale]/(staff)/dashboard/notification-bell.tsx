"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { markAllRead } from "./notification-actions";
import type { Notification } from "@/generated/prisma/client";

interface NotificationBellProps {
  /**
   * Server-rendered initial state (plan's "no live polling" ruling) — the
   * dashboard page fetches these via `getMyNotifications()`/`getUnreadCount()`
   * and passes them down, so the very first render already shows the real
   * count with no client-side fetch-on-mount flash.
   */
  initialNotifications: Notification[];
  initialUnreadCount: number;
}

/**
 * Dashboard header bell (spec §7). Opening the dropdown marks every
 * currently-listed notification as read — no per-item toggle (plan's
 * ruling) — via the `markAllRead()` server action, always scoped
 * server-side to the calling session.
 */
export function NotificationBell({ initialNotifications, initialUnreadCount }: NotificationBellProps) {
  const t = useTranslations("notifications.bell");
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [markReadError, setMarkReadError] = useState(false);

  async function handleToggle() {
    const opening = !open;
    setOpen(opening);
    if (!opening || unreadCount === 0) return;

    try {
      await markAllRead();
      setUnreadCount(0);
      setMarkReadError(false);
    } catch {
      // Best-effort: badge stays as-is on failure rather than silently
      // claiming success; the next open attempt (or page reload) retries.
      setMarkReadError(true);
    }
  }

  return (
    <div className="relative inline-block">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("label")}
        aria-expanded={open}
        onClick={handleToggle}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <Badge variant="destructive" className="absolute -top-1 -right-1">
            {unreadCount}
          </Badge>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded-md border bg-background p-3 shadow-md">
          {markReadError && <p className="mb-2 text-xs text-red-600">{t("markAllReadError")}</p>}
          {initialNotifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {initialNotifications.map((notification) => (
                <li key={notification.id} className="border-b pb-2 last:border-b-0 last:pb-0">
                  <p className="text-sm font-medium">{notification.title}</p>
                  <p className="text-sm text-muted-foreground">{notification.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
