"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const schema = z.object({ email: z.string().email() });

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
    const rawToken = generateRandomToken();
    const tokenHash = digestLookupSecret(rawToken, requireEnv("CODE_PEPPER"));

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const resetLink = `http://localhost:3000/${locale}/reset-password?token=${rawToken}`;
    // Stub for Phase 8's real email provider — printed, not sent, until then.
    console.log(`[password-reset] Reset link for ${user.email}: ${resetLink}`);
  }

  return { ok: true };
}
