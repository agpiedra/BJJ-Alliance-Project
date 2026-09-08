"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const schema = z.object({ email: z.string().email() });

/**
 * Raised at the point the reset link would otherwise be printed, when the
 * console-log stub is the only "delivery mechanism" configured and we are
 * running in production. Caught by `requestPasswordReset` itself — it must
 * never escape, see the note there.
 */
class ResetDeliveryNotConfiguredError extends Error {
  constructor() {
    super("Password reset email delivery is not yet configured (Phase 8) — cannot issue a reset link in production.");
    this.name = "ResetDeliveryNotConfiguredError";
  }
}

export async function requestPasswordReset(
  locale: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: "invalidEmail" };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Always behave identically whether or not the user exists — an
  // email-enumeration-safe response, matching the generic confirmation copy.
  if (user && user.active) {
    try {
      const rawToken = generateRandomToken();
      const tokenHash = digestLookupSecret(rawToken, requireEnv("CODE_PEPPER"));

      // Invalidate any of this user's existing unused reset tokens before
      // issuing a new one, so requesting a second link closes the replay
      // window the first link would otherwise keep open for up to an hour.
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const resetLink = `${requireEnv("APP_URL")}/${locale}/reset-password?token=${rawToken}`;

      // Phase 8 owns real email delivery. Until then the "provider" is a
      // console.log — acceptable in development, never in production, where
      // the platform aggregates stdout into a log store that a far wider
      // audience can read than the mailbox the link was meant for. A
      // single-use password-reset token sitting in a log line is an account
      // takeover waiting for whoever can read logs.
      if (process.env.NODE_ENV === "production") {
        throw new ResetDeliveryNotConfiguredError();
      }
      console.log(`[password-reset] Reset link for ${user.email}: ${resetLink}`);
    } catch (error) {
      // This is the whole reason the guard is a throw-and-catch rather than
      // a bare throw: letting it escape would turn a production 500 (email
      // exists, delivery unconfigured) against a normal 200 (email doesn't
      // exist, nothing attempted) into a brand-new enumeration oracle —
      // closing the token-leak hole by opening a different one. The response
      // below is unconditional, in every environment, on every path.
      if (error instanceof ResetDeliveryNotConfiguredError) {
        // No email, no token, no link in this line — an operator alarm only.
        console.error(
          "[password-reset] Reset requested but no email provider is configured (Phase 8); link withheld.",
        );
      } else {
        throw error;
      }
    }
  }

  return { ok: true };
}
