import type { EmailSendOutcome, ResendErrorCode } from "@/lib/email/send-transactional-email";

/**
 * The ONLY way the password-reset flow writes to the console (docs/PASSWORD_RECOVERY_PLAN.md §2.8). Every field is a
 * fixed enum or an allow-listed error code, so nothing here can carry a token, link, password, address, IP, id,
 * provider message or query parameter. Raw error objects and messages are never logged.
 */
export type PasswordResetLogEntry =
  | { event: "password_reset.throttled"; keyKind: "email" | "ip" }
  | {
      event: "password_reset.email";
      outcome: EmailSendOutcome | "not_scheduled" | "not_attempted";
      providerCode?: ResendErrorCode;
    }
  | { event: "password_reset.issue_failed"; error: SafeErrorCode }
  | { event: "password_reset.redeem_failed"; error: SafeErrorCode }
  | { event: "password_reset.token_cleanup_failed"; error: SafeErrorCode; sendAttempted: boolean }
  | { event: "password_reset.throttle_cleanup_failed"; error: SafeErrorCode };

const ALLOWED_ERROR_NAMES = [
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError",
  "PrismaClientValidationError",
  "PrismaClientRustPanicError",
  "TypeError",
  "RangeError",
] as const;

/** A Prisma error code (`P` + four digits), an allow-listed error class name, or the fixed fallback. */
export type SafeErrorCode = `P${number}` | (typeof ALLOWED_ERROR_NAMES)[number] | "unrecognized_error";

export function safeErrorCode(error: unknown): SafeErrorCode {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) return code as `P${number}`;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && (ALLOWED_ERROR_NAMES as readonly string[]).includes(name)) {
      return name as (typeof ALLOWED_ERROR_NAMES)[number];
    }
  }
  return "unrecognized_error";
}

export function logPasswordResetEvent(entry: PasswordResetLogEntry): void {
  if (entry.event === "password_reset.email" && entry.outcome === "accepted") {
    console.info("[password-reset]", entry);
  } else {
    console.warn("[password-reset]", entry);
  }
}
