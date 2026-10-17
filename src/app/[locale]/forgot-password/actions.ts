"use server";

import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { requestPasswordResetCore } from "@/lib/auth/password-reset";

const schema = z.object({ email: z.string().email() });

/**
 * docs/PASSWORD_RECOVERY_PLAN.md (rev 2). Returns `{ ok: true }` for EVERY well-formed address — unknown, inactive,
 * throttled, or issued with any email outcome — so the response never says whether an account exists. Identical text
 * does not make timing identical; see the plan's §2.3. The work is in src/lib/auth/password-reset.ts.
 */
export async function requestPasswordReset(
  locale: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: "invalidEmail" };
  }

  await requestPasswordResetCore({ email: parsed.data.email, locale: locale === "en" ? "en" : "es", ip: await resolveClientIp() });
  return { ok: true };
}

/**
 * The first `x-forwarded-for` value, for throttling only. Whether the hosting platform sets this header itself (and
 * discards a client-supplied one) is NOT verified, so the IP limit is best effort. No usable value — including
 * `headers()` failing outside a request — returns null and skips the IP limit, the same fail-open choice the
 * registration limiter documents (one shared "unknown" bucket would lock out everyone).
 */
async function resolveClientIp(): Promise<string | null> {
  try {
    const forwardedFor = (await headers()).get("x-forwarded-for");
    return forwardedFor?.split(",")[0]?.trim() || null;
  } catch {
    return null;
  }
}
