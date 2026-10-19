/**
 * What may be said about a failed Resend send, shared by `sendTransactionalEmail` and the notification `EmailChannel`.
 * Deliberately import-free: tests mock `send-transactional-email` wholesale, and `EmailChannel` must keep working there.
 */
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

/**
 * Shadows the SDK's private `logError` on this one client instance — no global console change, no NODE_ENV change.
 * resend@6.27.0 prints the provider's raw error object (`console.error("[Resend API Error]:", …)`) whenever
 * `NODE_ENV !== "production"`; that object is free text that can carry the recipient or other request details.
 * It depends on that internal method name; tests/integration/password-reset-email-client.test.ts and
 * email-error-logging.test.ts drive the real SDK with only `fetch` mocked and fail if an SDK upgrade starts logging
 * provider errors again.
 */
export function silenceSdkErrorLogging(client: object): void {
  (client as { logError: (...args: unknown[]) => void }).logError = () => {};
}
