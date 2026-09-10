import { requireEnv } from "@/lib/env";
import type { DeliveryResult, NotificationChannel, Recipient, RenderedMessage } from "@/lib/notifications/types";

/**
 * The slice of the Resend SDK's client this channel actually calls, narrowed
 * to just `emails.send` so a unit test can inject a fake object instead of
 * implementing (or mocking) the whole `Resend` class. The real `Resend`
 * client (from the `resend` package) satisfies this structurally.
 */
export interface ResendClient {
  emails: {
    send(params: { from: string; to: string; subject: string; html: string }): Promise<{
      data: { id: string } | null;
      error: { message: string; name?: string } | null;
    }>;
  };
}

/** A minimal paragraph-per-line wrapper — not a templating engine. */
function bodyToHtml(body: string): string {
  return body
    .split("\n")
    .map((line) => `<p>${line}</p>`)
    .join("");
}

/**
 * Sends a notification by email via Resend. The Resend client is injected
 * via the constructor rather than constructed here, so tests can pass a fake
 * `emails.send` stub instead of making a real network call.
 */
export class EmailChannel implements NotificationChannel {
  supportsInboundReplies = false;

  constructor(private readonly client: ResendClient) {}

  // Must never throw: a raw Resend/network exception is translated into the
  // `DeliveryResult` contract here, the one place that owns this concern,
  // rather than pushing it onto every caller (dispatchNotification also
  // isolates failures, but shouldn't have to rely on that as the only guard).
  async send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult> {
    try {
      const { error } = await this.client.emails.send({
        from: requireEnv("EMAIL_FROM"),
        to: to.email,
        subject: message.title,
        html: bodyToHtml(message.body),
      });
      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
