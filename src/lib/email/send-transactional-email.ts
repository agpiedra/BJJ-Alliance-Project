import { Resend } from "resend";
import { requireEnv } from "@/lib/env";
import { bodyToHtml } from "@/lib/notifications/email-channel";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — real transactional email for the
 * registration-confirmation and invitation emails, the first things a
 * prospective customer sees from this product.
 *
 * Deliberately NOT forgot-password/actions.ts's pattern: that flow's
 * token-link email is still a `console.log` stub, explicitly deferred to
 * REDESIGN_BRIEF.md's own Phase 8 (a different document's Phase 8 — see
 * this repo's "qualify phase numbers with the document name" rule; not
 * MULTI_ACADEMY_AND_KIDS_BELTS.md's Phase 8). That stub is tolerable for a
 * low-frequency, already-authenticated-user recovery flow during
 * pre-launch dev. It is not acceptable here: these two emails are the
 * actual product experience for a real prospective academy, so this uses
 * the SAME real, already-proven Resend wiring `src/lib/notifications/channels.ts`
 * uses for staff notifications — not a copy of the stub.
 *
 * Deliberately NOT the `NotificationChannel`/`dispatchNotification` system
 * either: that machinery renders a `Notification` DB row and a
 * `Recipient` shaped around an existing `User.id`/`locale`. Neither email
 * here has that — a registration confirmation's recipient may never become
 * a `User`, and an invitation's recipient doesn't have one yet. A plain,
 * direct send is the right shape for a one-shot email to an address that
 * isn't (yet) an app user.
 */
export interface TransactionalEmailResult {
  success: boolean;
  error?: string;
}

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  bodyLines: string[],
): Promise<TransactionalEmailResult> {
  try {
    const client = new Resend(requireEnv("RESEND_API_KEY"));
    const { error } = await client.emails.send({
      from: requireEnv("EMAIL_FROM"),
      to,
      subject,
      html: bodyToHtml(bodyLines.join("\n")),
    });
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
