import type { NotificationType } from "@/generated/prisma/client";
import type { EmailSendOutcome, ResendErrorCode } from "@/lib/email/provider-errors";

export type { NotificationType };

/** A single notification recipient, resolved independently of any session — see recipients.ts. */
export interface Recipient {
  userId: string;
  email: string;
  locale: string;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1: Notification.organizationId is
   * required now — the org the notification is about, not necessarily the
   * recipient's only membership. */
  organizationId: string;
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
  /** Email channel only: what is known about the request, and the provider's fixed code — the only fields ever logged. */
  outcome?: EmailSendOutcome;
  providerCode?: ResendErrorCode;
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
