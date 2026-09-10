import type { NotificationChannel, Recipient, RenderedMessage } from "@/lib/notifications/types";

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
