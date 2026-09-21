import type { JWT } from "next-auth/jwt";
import authConfig from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { resolveActiveOrganizationForSignIn } from "@/lib/tenant/active-organization";
import { deriveAccess } from "@/lib/auth/derive-access";

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
export async function signInJwtCallback(params: JwtCallbackParams): Promise<JWT> {
  const token = await authConfig.callbacks!.jwt!(params);

  if (params.user) {
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
  // an explicit `{ refreshAccess: true }` (same organization, the database may have
  // changed under a live session — a promotion, a demotion). Between updates the
  // claim is only a hint, never authority: every page re-derives access from the
  // database on every request (see route-access.ts).
  if (params.user || params.trigger === "update") {
    token.access = await deriveAccess(token.id as string, (token.activeOrganizationId as string | null) ?? null);
  }

  return token;
}
