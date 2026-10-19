import { Resend } from "resend";
import { requireEnv } from "@/lib/env";
import { bodyToHtml } from "@/lib/notifications/email-channel";
import { classifyProviderError, silenceSdkErrorLogging, type EmailSendOutcome, type ResendErrorCode } from "@/lib/email/provider-errors";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — real transactional email for the
 * registration-confirmation and invitation emails, the first things a
 * prospective customer sees from this product.
 *
 * Also the password-reset email (src/lib/auth/password-reset.ts, docs/PASSWORD_RECOVERY_PLAN.md), which replaced
 * forgot-password's former `console.log` stub. Uses the SAME real Resend wiring `src/lib/notifications/channels.ts`
 * uses for staff notifications.
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
  /**
   * What is actually known about the request (docs/PASSWORD_RECOVERY_PLAN.md §2.6). `accepted` means the provider took
   * the request — never that it was delivered. `unknown` means acceptance cannot be determined (network failure, a
   * provider-side error, an unrecognized code) and must never be reported as rejected or undelivered.
   */
  outcome: EmailSendOutcome;
  /** The provider's error code, only when it is one of the SDK's fixed codes — never its free-text message. */
  providerCode?: ResendErrorCode;
}

// Moved to an import-free module so the notification EmailChannel can share them; re-exported for existing callers.
export { classifyProviderError, type EmailSendOutcome, type ResendErrorCode } from "@/lib/email/provider-errors";

export interface SendTransactionalEmailOptions {
  /**
   * Stops the Resend SDK's own error logging for this send. resend@6.27.0 prints the provider's raw error object
   * (`console.error("[Resend API Error]:", …)`) whenever `NODE_ENV !== "production"`; that object is free text that
   * can carry the recipient or other request details. Off by default, so existing callers behave exactly as before.
   */
  suppressProviderErrorLogging?: boolean;
}

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  bodyLines: string[],
  options: SendTransactionalEmailOptions = {},
): Promise<TransactionalEmailResult> {
  let apiKey: string;
  let from: string;
  try {
    apiKey = requireEnv("RESEND_API_KEY");
    from = requireEnv("EMAIL_FROM");
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), outcome: "not_configured" };
  }

  try {
    const client = new Resend(apiKey);
    if (options.suppressProviderErrorLogging) silenceSdkErrorLogging(client);
    const { error } = await client.emails.send({
      from,
      to,
      subject,
      html: bodyToHtml(bodyLines.join("\n")),
    });
    if (error) {
      return { success: false, error: error.message, ...classifyProviderError(error.name) };
    }
    return { success: true, outcome: "accepted" };
  } catch (err) {
    // Thrown during or around the request: whether the provider took it cannot be known.
    return { success: false, error: err instanceof Error ? err.message : String(err), outcome: "unknown" };
  }
}
