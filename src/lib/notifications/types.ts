import type { NotificationType } from "@/generated/prisma/client";

export type { NotificationType };

/** A single notification recipient, resolved independently of any session — see recipients.ts. */
export interface Recipient {
  userId: string;
  email: string;
  locale: string;
}

/** The rendered title/body for one notification, in the recipient's locale. */
export interface RenderedMessage {
  type: NotificationType;
  title: string;
  body: string;
}

export interface DeliveryResult {
  success: boolean;
  error?: string;
}

/**
 * One delivery mechanism for a rendered notification (in-app row, email,
 * eventually WhatsApp — spec's own stated reason this is an interface and
 * not a single hardcoded channel). `send` must never throw for an
 * individual failure; `dispatchNotification` (dispatch.ts) treats every
 * failure as best-effort, but a channel that throws instead of returning
 * `{ success: false }` is still caught there, not relied upon here.
 */
export interface NotificationChannel {
  send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult>;
  /** Whether a reply to this channel's message can reach staff (email: yes; in-app: no). */
  supportsInboundReplies: boolean;
}
