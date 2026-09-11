import { renderNotificationMessage } from "@/lib/notifications/templates";
import type { NotificationChannel, NotificationType, Recipient, RenderedMessage } from "@/lib/notifications/types";

/**
 * Fans a rendered message out to every recipient x every channel,
 * best-effort: an individual `channel.send` call throwing (or a channel
 * that returns `{ success: false }`) must never block any other
 * recipient/channel combination or bubble up to the caller — a failed
 * notification is never worth breaking the flow (check-in, signup) that
 * triggered it. Uses `Promise.allSettled`, not `Promise.all`, so it always
 * resolves once every attempt has settled; failures are only logged.
 */
export async function dispatchNotification(
  recipients: Recipient[],
  message: RenderedMessage,
  channels: NotificationChannel[],
): Promise<void> {
  const attempts = recipients.flatMap((recipient) =>
    channels.map(async (channel) => {
      const result = await channel.send(recipient, message);
      if (!result.success) {
        console.error("notification delivery failed", {
          userId: recipient.userId,
          type: message.type,
          error: result.error,
        });
      }
    }),
  );

  const settled = await Promise.allSettled(attempts);
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      console.error("notification channel threw", outcome.reason);
    }
  }
}

/**
 * Renders and dispatches one notification PER RECIPIENT, in THAT recipient's
 * own `locale` — never a single shared locale rendered once for the whole
 * fan-out (the I-2/I-3 bug: an English-preferring ADMIN was getting Spanish
 * stripe/exam/signup/digest notifications because every trigger rendered
 * once with `routing.defaultLocale`/whatever locale happened to be handy and
 * blasted the same rendered message to everyone).
 *
 * Shared by all four trigger functions (`notifyEligibilityReached`,
 * `notifyNewSignup`, `sendWeeklyDigestForAcademy`) instead of each
 * duplicating this same "for each recipient, render in their locale,
 * dispatch" loop — and it's the loop that gives every trigger
 * `dispatchNotification`'s existing failure logging/`Promise.allSettled`
 * isolation for free, including the digest, which used to bypass
 * `dispatchNotification` entirely and silently discard failed sends.
 */
export async function dispatchToRecipients(
  recipients: Recipient[],
  type: NotificationType,
  data: Record<string, unknown>,
  channels: NotificationChannel[],
): Promise<void> {
  await Promise.all(
    recipients.map((recipient) => {
      const message = renderNotificationMessage(type, data, recipient.locale);
      return dispatchNotification([recipient], message, channels);
    }),
  );
}
