import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { PLATFORM_NAME } from "@/lib/platform";
import { scheduleAfterResponse } from "@/lib/after-response";
import { sendTransactionalEmail } from "@/lib/email/send-transactional-email";
import { claimResetRequest, resetThrottleKeys, sweepExpiredResetRequests } from "@/lib/auth/password-reset-throttle";
import { logPasswordResetEvent, safeErrorCode } from "@/lib/auth/password-reset-log";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md (rev 2). A plain module, NOT a "use server" file: everything exported here takes
 * already-validated input and must only be reachable through the two thin actions in
 * src/app/[locale]/forgot-password/actions.ts and src/app/[locale]/reset-password/actions.ts.
 *
 * Lock order, everywhere: the `User` row (`SELECT … FOR UPDATE`) first, then that user's `PasswordResetToken` rows.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export type ResetLocale = "en" | "es";

/**
 * Every outcome — unknown address, inactive account, throttled, issued with any email outcome, scheduling failure, or
 * an infrastructure failure at any step — returns the same `void`; the action turns it into one uniform response.
 * Never throws. A failed safeguard STOPS the request rather than continuing past it: if the throttle cannot be
 * checked, or the account cannot be looked up, no token is issued and no email is scheduled.
 */
export async function requestPasswordResetCore(input: { email: string; locale: ResetLocale; ip: string | null }): Promise<void> {
  let claim: Awaited<ReturnType<typeof claimResetRequest>>;
  try {
    claim = await claimResetRequest(resetThrottleKeys(input.email, input.ip));
  } catch (error) {
    // Fail closed: an unchecked throttle never lets a request through.
    logPasswordResetEvent({ event: "password_reset.throttle_failed", error: safeErrorCode(error) });
    return;
  }
  await sweepExpiredResetRequests();
  if (!claim.allowed) {
    logPasswordResetEvent({ event: "password_reset.throttled", keyKind: claim.keyKind });
    return;
  }

  let user: { id: string } | null;
  try {
    user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.lookup_failed", error: safeErrorCode(error) });
    return;
  }
  if (!user) return;

  const rawToken = generateRandomToken();
  let issued: IssuedToken | null;
  let appUrl: string;
  try {
    // Configuration is read here, inside the catch, so a missing value for an existing account cannot answer
    // differently from an unknown address.
    appUrl = requireEnv("APP_URL");
    issued = await issueResetToken(user.id, digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")));
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.issue_failed", error: safeErrorCode(error) });
    return;
  }
  if (!issued) return;

  const { tokenId, email } = issued;
  const link = `${appUrl}/${input.locale}/reset-password?token=${rawToken}`;
  const scheduled = scheduleAfterResponse(() => deliverResetEmail({ tokenId, to: email, link, locale: input.locale }));
  if (!scheduled) {
    // Nothing was sent and nothing will be: this token's raw value was never transmitted anywhere.
    logPasswordResetEvent({ event: "password_reset.email", outcome: "not_scheduled" });
    await invalidateIssuedToken(tokenId, false);
  }
}

interface IssuedToken {
  tokenId: string;
  email: string;
}

/** User lock first; re-checks `active` under it; leaves exactly one unused token for the user. */
async function issueResetToken(userId: string, tokenHash: string): Promise<IssuedToken | null> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ active: boolean; email: string }[]>`
      SELECT "active", "email" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!row?.active) return null;

    const now = new Date();
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    const token = await tx.passwordResetToken.create({
      data: { userId, tokenHash, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) },
      select: { id: true },
    });
    return { tokenId: token.id, email: row.email };
  });
}

/**
 * The after-response step. `after()` is not durable: this may never run, or stop partway, with no retry. It never
 * throws. It acts only on what is known:
 *   - the provider explicitly refused, or email is not configured: this token is made unusable;
 *   - acceptance unknown, or accepted: the token stays valid (an email may exist);
 *   - an exception before the provider call started: nothing was sent, so the token is made unusable;
 *   - an exception after it started: acceptance is unknown, so the token stays valid.
 */
async function deliverResetEmail(input: { tokenId: string; to: string; link: string; locale: ResetLocale }): Promise<void> {
  let sendStarted = false;
  try {
    const message = resetEmailMessage(input.locale, input.link);
    sendStarted = true;
    const result = await sendTransactionalEmail(input.to, message.subject, message.lines, { suppressProviderErrorLogging: true });
    logPasswordResetEvent({
      event: "password_reset.email",
      outcome: result.outcome,
      ...(result.providerCode ? { providerCode: result.providerCode } : {}),
    });
    if (result.outcome === "rejected") await invalidateIssuedToken(input.tokenId, true);
    if (result.outcome === "not_configured") await invalidateIssuedToken(input.tokenId, false);
  } catch {
    if (sendStarted) {
      logPasswordResetEvent({ event: "password_reset.email", outcome: "unknown" });
    } else {
      logPasswordResetEvent({ event: "password_reset.email", outcome: "not_attempted" });
      await invalidateIssuedToken(input.tokenId, false);
    }
  }
}

/**
 * Marks ONE token unusable, by its own id — never the user's other tokens, so a late cleanup for an older send can
 * never touch a newer request's token, and it is a no-op if that token was already redeemed or superseded. Never
 * throws. On failure the token stays redeemable until it expires; `sendAttempted` records whether a provider request
 * carrying the link may have been made, without inferring anything about who holds it.
 */
export async function invalidateIssuedToken(tokenId: string, sendAttempted: boolean): Promise<void> {
  try {
    await prisma.passwordResetToken.updateMany({ where: { id: tokenId, usedAt: null }, data: { usedAt: new Date() } });
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.token_cleanup_failed", error: safeErrorCode(error), sendAttempted });
  }
}

function resetEmailMessage(locale: ResetLocale, link: string): { subject: string; lines: string[] } {
  return locale === "en"
    ? {
        subject: `Reset your ${PLATFORM_NAME} password`,
        lines: [
          `We received a request to reset the password for your ${PLATFORM_NAME} account.`,
          "Open this link to choose a new password:",
          link,
          "This link expires in 1 hour. If you requested more than one, only the most recent link works.",
          "If you didn't ask for this, you can ignore this email.",
        ],
      }
    : {
        subject: `Restablece tu contraseña de ${PLATFORM_NAME}`,
        lines: [
          `Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${PLATFORM_NAME}.`,
          "Abre este enlace para elegir una contraseña nueva:",
          link,
          "Este enlace vence en 1 hora. Si pediste más de uno, solo funciona el más reciente.",
          "Si no lo pediste, puedes ignorar este correo.",
        ],
      };
}

export type RedeemResult = { ok: true } | { ok: false; reason: "invalidToken" | "failed" };

const INVALID: RedeemResult = { ok: false, reason: "invalidToken" };
/** An infrastructure failure — never reported as an invalid token, and never a partial change. */
const FAILED: RedeemResult = { ok: false, reason: "failed" };

/**
 * Single-use redemption. A preliminary, UNLOCKED read rejects missing, used, expired or inactive-account tokens before
 * the expensive bcrypt hash; it is not authoritative. The authoritative checks are repeated inside one transaction
 * under the user lock, with expiry evaluated against a fresh time taken after the lock is held. Any refusal or error
 * leaves the password unchanged and the token unused.
 */
export async function redeemPasswordResetToken(input: { rawToken: string; newPassword: string }): Promise<RedeemResult> {
  let candidate: { id: string; userId: string; usedAt: Date | null; expiresAt: Date; user: { active: boolean } } | null;
  try {
    const tokenHash = digestLookupSecret(input.rawToken, requireEnv("CODE_PEPPER"));
    candidate = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, usedAt: true, expiresAt: true, user: { select: { active: true } } },
    });
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.redeem_failed", stage: "lookup", error: safeErrorCode(error) });
    return FAILED;
  }
  if (!candidate || candidate.usedAt || candidate.expiresAt.getTime() <= Date.now() || !candidate.user.active) {
    return INVALID;
  }

  let passwordHash: string;
  try {
    passwordHash = await hashSecret(input.newPassword);
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.redeem_failed", stage: "hash", error: safeErrorCode(error) });
    return FAILED;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT "active" FROM "User" WHERE "id" = ${candidate.userId} FOR UPDATE`;
      if (!row?.active) return INVALID;

      const now = new Date();
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: candidate.id, userId: candidate.userId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return INVALID;

      // Same statement, same transaction: the new password and the end of every earlier session commit together, or
      // neither does (src/lib/auth/session-credentials.ts).
      await tx.user.update({ where: { id: candidate.userId }, data: { passwordHash, credentialsVersion: { increment: 1 } } });
      await tx.passwordResetToken.updateMany({ where: { userId: candidate.userId, usedAt: null }, data: { usedAt: now } });
      return { ok: true } as const;
    });
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.redeem_failed", stage: "transaction", error: safeErrorCode(error) });
    return FAILED;
  }
}
