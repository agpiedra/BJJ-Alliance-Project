import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { encode } from "next-auth/jwt";
import authConfig from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";

/**
 * Dev-only session-minting backdoor for Playwright/manual screenshot
 * verification — NOT a login mechanism, and not a fix for either real bug
 * tracked in KNOWN_LIMITATIONS (scripts/pending-callers.ts): real login's
 * `signIn()` cookie failure, and requireTenantContext()'s redirect to
 * `/login` for any session whose `activeOrganizationId` is still null (true
 * of every fresh sign-in — nothing yet sets it to a real value outside a
 * not-yet-built org switcher). Real login must still work end-to-end before
 * anything built here is shown to Alliance.
 *
 * Every gate below runs, in order, before any other statement — a missing
 * `E2E_AUTH_BYPASS_SECRET`, a non-local `Host`, or a wrong secret all
 * produce the exact same 404 a nonexistent route would, with nothing to
 * distinguish which gate failed. This mints a session for an existing,
 * active, caller-chosen user id by running the app's own `jwt` callback
 * (the same authorization-shaping logic a real login uses) twice — once as
 * a sign-in, once as an org-selecting update, exactly the two real steps a
 * working login-then-switch-org flow would take — and encoding the result
 * the way Auth.js encodes a real session token. It replaces
 * *authentication*, never *authorization*: the organization it selects must
 * already be a real `OrganizationMembership` row for that exact user, and
 * every later request still re-validates that membership from the database
 * on its own, so this cannot grant access to an organization the target
 * user doesn't belong to.
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

  // Real membership, always re-checked here — a caller-supplied
  // `organizationId` is only ever used if it matches a row that actually
  // exists for this exact user. No membership at all just leaves the
  // session's org selector null, same as an unfixed real login today.
  const membership = await prisma.organizationMembership.findFirst({
    where: requestedOrganizationId ? { userId: user.id, organizationId: requestedOrganizationId } : { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  if (requestedOrganizationId && !membership) {
    return notFound();
  }

  const jwtCallback = authConfig.callbacks?.jwt;
  if (!jwtCallback) {
    return notFound();
  }
  const signInParams = {
    token: { sub: user.id, email: user.email, name: user.email },
    user: { id: user.id, email: user.email, role: user.role, name: user.email },
    trigger: "signIn",
  } as Parameters<typeof jwtCallback>[0];
  let token = await jwtCallback(signInParams);

  if (membership) {
    const updateParams = {
      token,
      trigger: "update",
      session: { activeOrganizationId: membership.organizationId },
    } as Parameters<typeof jwtCallback>[0];
    token = await jwtCallback(updateParams);
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
