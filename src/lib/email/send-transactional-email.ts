import { Resend } from "resend";
import { requireEnv } from "@/lib/env";
import { bodyToHtml } from "@/lib/notifications/email-channel";

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

export type EmailSendOutcome = "accepted" | "rejected" | "unknown" | "not_configured";

/** Every `RESEND_ERROR_CODE_KEY` value in resend@6.27.0. */
const RESEND_ERROR_CODES = [
  "invalid_idempotency_key",
  "validation_error",
  "missing_api_key",
  "restricted_api_key",
  "invalid_api_key",
  "not_found",
  "method_not_allowed",
  "invalid_idempotent_request",
  "concurrent_idempotent_requests",
  "invalid_attachment",
  "invalid_from_address",
  "invalid_access",
  "invalid_parameter",
  "invalid_region",
  "missing_required_field",
  "monthly_quota_exceeded",
  "daily_quota_exceeded",
  "rate_limit_exceeded",
  "security_error",
  "application_error",
  "internal_server_error",
] as const;
export type ResendErrorCode = (typeof RESEND_ERROR_CODES)[number];

/**
 * Codes that mean the provider answered and did not take the request. Everything else — `internal_server_error`,
 * `application_error` (which the SDK also returns for a network failure or an unparseable response), the idempotency
 * conflicts, and any code outside the fixed list — leaves acceptance unknown.
 */
const REJECTION_CODES: ReadonlySet<string> = new Set<ResendErrorCode>([
  "invalid_idempotency_key",
  "validation_error",
  "missing_api_key",
  "restricted_api_key",
  "invalid_api_key",
  "not_found",
  "method_not_allowed",
  "invalid_attachment",
  "invalid_from_address",
  "invalid_access",
  "invalid_parameter",
  "invalid_region",
  "missing_required_field",
  "monthly_quota_exceeded",
  "daily_quota_exceeded",
  "rate_limit_exceeded",
  "security_error",
]);

export function classifyProviderError(name: unknown): { outcome: "rejected" | "unknown"; providerCode?: ResendErrorCode } {
  const providerCode = typeof name === "string" && (RESEND_ERROR_CODES as readonly string[]).includes(name) ? (name as ResendErrorCode) : undefined;
  return { outcome: providerCode !== undefined && REJECTION_CODES.has(providerCode) ? "rejected" : "unknown", providerCode };
}

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  bodyLines: string[],
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
