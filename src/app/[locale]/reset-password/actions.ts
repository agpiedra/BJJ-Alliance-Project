"use server";

import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { redeemPasswordResetToken } from "@/lib/auth/password-reset";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

/** docs/PASSWORD_RECOVERY_PLAN.md (rev 2) — single-use redemption lives in src/lib/auth/password-reset.ts. */
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

  const result = await redeemPasswordResetToken({ rawToken: parsed.data.token, newPassword: parsed.data.password });
  if (result.ok) return { ok: true };
  return { error: result.reason === "invalidToken" ? "invalidToken" : "resetFailed" };
}
