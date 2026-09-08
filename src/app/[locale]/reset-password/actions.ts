"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function resetPassword(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "invalidToken", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const tokenHash = digestLookupSecret(parsed.data.token, requireEnv("CODE_PEPPER"));
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return { error: "invalidToken" };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashSecret(parsed.data.password) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return { ok: true };
}
