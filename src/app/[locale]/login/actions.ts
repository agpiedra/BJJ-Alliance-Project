"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { ActionState } from "@/lib/action-state";
import { sanitizeCallbackUrl } from "@/lib/callback-url";
import { landingPathForUser } from "@/lib/auth/landing";
import { logLoginEvent } from "@/lib/auth/login-throttle";
import { safeErrorCode } from "@/lib/auth/password-reset-log";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(
  locale: string,
  callbackUrl: string | undefined,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const safeCallbackUrl = sanitizeCallbackUrl(callbackUrl);

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "invalidCredentials", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // signIn() must carry out its own redirect (never `redirect: false`) —
  // that internal redirect is what actually attaches the session cookie to
  // the response. `redirect: false` leaves the cookie unset, which is why
  // logins were completing but never sticking. So the landing target has to
  // be known BEFORE calling signIn, not decided from its result afterward.
  // Querying by the submitted email only decides where a successful login
  // lands — it never decides whether it succeeds.
  let redirectTarget = safeCallbackUrl;
  if (!redirectTarget) {
    // Decided from the DATABASE (memberships and the linked student record), never
    // the global `User.role`: staff — a coach who also trains included — land in the
    // staff app, everyone else with a portal in the portal.
    //
    // Its own narrow boundary: plain queries only (no redirect()), so catching everything here cannot swallow a
    // Next.js redirect. A failure answers like any other refusal, logs only an allow-listed code, and checks no
    // password (docs/LOGIN_THROTTLING_PLAN.md §5).
    try {
      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true },
      });
      redirectTarget = `/${locale}${user ? await landingPathForUser(user.id) : "/dashboard"}`;
    } catch (error) {
      logLoginEvent({ event: "login.preauth_lookup_failed", error: safeErrorCode(error) });
      return { error: "invalidCredentials" };
    }
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: redirectTarget,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "invalidCredentials" };
    }
    throw error;
  }

  return {};
}
