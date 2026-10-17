import type { JWT } from "next-auth/jwt";
import authConfig from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { resolveActiveOrganizationForSignIn } from "@/lib/tenant/active-organization";
import { deriveAccess } from "@/lib/auth/derive-access";
import { sessionCredentialsCurrent } from "@/lib/auth/session-credentials";

type JwtCallback = NonNullable<NonNullable<typeof authConfig.callbacks>["jwt"]>;
export type JwtCallbackParams = Parameters<JwtCallback>[0];

/**
 * The ONE place that resolves `activeOrganizationId` at sign-in time or on
 * an explicit `unstable_update()` call — used by BOTH `src/auth.ts`'s real
 * NextAuth instance (as its `jwt` callback override) AND
 * `src/app/api/e2e-auth-bypass/route.ts`'s dev-only session minting.
 * Sharing the literal function, not just matching behavior by convention,
 * is what makes tests/integration/e2e-auth-bypass-equals-real-login.test.ts
 * a real guarantee rather than a hope: the bypass cannot silently drift
 * from real login's `activeOrganizationId` resolution because it is not a
 * second implementation of it.
 *
 * Kept out of src/auth.config.ts itself (which this wraps) because that
 * file is also used by src/middleware.ts's lightweight Edge-runtime
 * `NextAuth(authConfig)` instance, which must never import Prisma (see
 * that file's own comment). This module — and everything it imports — is
 * Node-only, and is used only by real sign-in (src/auth.ts) and the
 * screenshot-only bypass, never by middleware.
 */
export async function signInJwtCallback(params: JwtCallbackParams): Promise<JWT | null> {
  // Session revocation (src/lib/auth/session-credentials.ts). Every call that is NOT a fresh sign-in — every
  // server-side `auth()` session read, `unstable_update`, and the `/api/auth/session` handler — first checks the token's
  // captured credentials version against the user's current one. `null` ends the session: Auth.js returns no session
  // (and, where it can set cookies, clears the cookie). It runs before the update branch below, so an organization or
  // session update can never revive a stale token, and the stored version is never copied into the token here.
  if (!params.user && !(await sessionCredentialsCurrent(params.token))) {
    return null;
  }

  const token = await authConfig.callbacks!.jwt!(params);

  if (params.user) {
    // The version read together with the verified password hash (verify-credentials.ts) — never re-read here, so a
    // reset that commits between password verification and this point cannot give an old-password login the new
    // version. A sign-in without it is refused rather than guessed.
    const version = (params.user as { credentialsVersion?: unknown }).credentialsVersion;
    if (typeof version !== "number") return null;
    token.cv = version;

    const resolution = await resolveActiveOrganizationForSignIn(token.id as string);
    token.activeOrganizationId = resolution.kind === "resolved" ? resolution.organizationId : null;
    if (resolution.kind === "resolved") {
      await prisma.user.update({
        where: { id: token.id as string },
        data: { lastActiveOrganizationId: resolution.organizationId },
      });
    }
  }

  if (params.trigger === "update" && params.session && "activeOrganizationId" in params.session) {
    const nextOrgId = (params.session as { activeOrganizationId: string | null }).activeOrganizationId;
    if (nextOrgId) {
      await prisma.user.update({
        where: { id: token.id as string },
        data: { lastActiveOrganizationId: nextOrgId },
      });
    }
  }

  // The `{ staff, portal }` claim the Edge middleware reads, derived from the
  // DATABASE for the organization the person is now acting in — at sign-in, and on
  // ANY session update: an organization switch (a new organization, a new claim) or
  // an explicit refresh (`unstable_update` for the same organization — the database may have
  // changed under a live session — a promotion, a demotion). Between updates the
  // claim is only a hint, never authority: every page re-derives access from the
  // database on every request (see route-access.ts).
  if (params.user || params.trigger === "update") {
    token.access = await deriveAccess(token.id as string, (token.activeOrganizationId as string | null) ?? null);
  }

  return token;
}
