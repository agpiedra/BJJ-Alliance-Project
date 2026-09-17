import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { encode } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { signInJwtCallback, type JwtCallbackParams } from "@/lib/auth/sign-in-jwt-callback";

/**
 * Dev-only session-minting backdoor for Playwright/manual screenshot
 * verification — NOT a login mechanism. Real login must still work
 * end-to-end before anything built here is shown to Alliance (see
 * KNOWN_LIMITATIONS in scripts/pending-callers.ts for the closed finding
 * this route was built to work around while it was still broken).
 *
 * Every gate below runs, in order, before any other statement — a missing
 * `E2E_AUTH_BYPASS_SECRET`, a non-local `Host`, or a wrong secret all
 * produce the exact same 404 a nonexistent route would, with nothing to
 * distinguish which gate failed. This mints a session for an existing,
 * active, caller-chosen user id by running the app's own `jwt` callback
 * (the same id/role-shaping logic a real login uses) and then resolving
 * `activeOrganizationId` via the EXACT SAME `resolveActiveOrganizationForSignIn`
 * function `src/auth.ts`'s real sign-in path calls — deliberately not a
 * second, independently-written membership lookup, so this route's
 * resolution can never silently drift from what real login would produce
 * for the same user (see tests/integration/e2e-auth-bypass-equals-real-login.test.ts,
 * which asserts the two are structurally identical, not just "both work").
 * A caller-supplied `organizationId` is only ever used if it names a real,
 * active membership for this exact user — otherwise it's ignored in favor
 * of that same resolution, never trusted as an override into somewhere the
 * user doesn't belong.
 */

const SESSION_COOKIE_NAME = "authjs.session-token";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function enabledSecret(): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return process.env.E2E_AUTH_BYPASS_SECRET || undefined;
}

function isLocalHost(request: Request): boolean {
  const hostname = (request.headers.get("host") ?? "").split(":")[0];
  return LOCAL_HOSTNAMES.has(hostname);
}

function secretsMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const expectedSecret = enabledSecret();
  if (!expectedSecret || !isLocalHost(request)) {
    return notFound();
  }

  const body = (await request.json().catch(() => null)) as
    | { userId?: unknown; secret?: unknown; organizationId?: unknown }
    | null;
  const providedSecret = typeof body?.secret === "string" ? body.secret : "";
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const requestedOrganizationId = typeof body?.organizationId === "string" ? body.organizationId : undefined;
  if (!secretsMatch(expectedSecret, providedSecret)) {
    return notFound();
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, active: true },
  });
  if (!user || !user.active) {
    return notFound();
  }

  // Step 1: sign in — LITERALLY the same call src/auth.ts's real signIn()
  // flow makes to this same function. This alone already resolves
  // activeOrganizationId exactly as real login would (auto for one active
  // membership, null for zero or an unresolved 2+).
  let token = await signInJwtCallback({
    token: { sub: user.id, email: user.email, name: user.email },
    user: { id: user.id, email: user.email, role: user.role, name: user.email },
    trigger: "signIn",
  } as JwtCallbackParams);

  // Step 2, optional: a caller-supplied organizationId is handled as an
  // explicit post-sign-in switch — the same shape a real
  // unstable_update({activeOrganizationId}) call takes (see
  // select-organization/actions.ts), and re-validated the same way: it
  // must name a real, ACTIVE membership for this exact user, never trusted
  // as a bare override.
  if (requestedOrganizationId) {
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId: user.id, organizationId: requestedOrganizationId, organization: { status: "ACTIVE" } },
      select: { organizationId: true },
    });
    if (!membership) {
      return notFound();
    }
    token = await signInJwtCallback({
      token,
      trigger: "update",
      session: { activeOrganizationId: membership.organizationId },
    } as JwtCallbackParams);
  }

  const sessionToken = await encode({
    token,
    secret: requireEnv("AUTH_SECRET"),
    salt: SESSION_COOKIE_NAME,
  });

  const response = NextResponse.json({ ok: true, userId: user.id });
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
  });
  return response;
}
