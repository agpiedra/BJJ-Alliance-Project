import type { NextAuthConfig } from "next-auth";
import { isAccessClaim } from "@/lib/auth/route-access";

export default {
  providers: [],
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // Edge-safe base callback — shared with src/middleware.ts's own
      // lightweight `NextAuth(authConfig)` instance, which must never pull
      // in Prisma (the pg driver adapter needs Node's `net`/`tls`, not
      // available in the Edge runtime middleware defaults to). Real
      // credentials sign-in only ever happens through src/auth.ts's Node
      // instance (middleware has no provider and never calls signIn()), so
      // `user` here only carries the id — the DB-backed
      // `activeOrganizationId` resolution lives entirely in src/auth.ts's
      // own `jwt` callback override, which wraps this one.
      if (user) {
        token.id = user.id;
      }
      // Set via `unstable_update({ activeOrganizationId })` — today by
      // src/app/[locale]/select-organization/actions.ts (the explicit
      // multi-membership picker) and Phase 5's future in-app org switcher.
      // That caller must re-validate membership before calling this, so the
      // token is never trusted as the source of authority, only as a
      // selector (Appendix C decision 4 / proposal point 1).
      if (trigger === "update" && session && "activeOrganizationId" in session) {
        token.activeOrganizationId = (session as { activeOrganizationId: string | null }).activeOrganizationId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      // Deliberately NO `role`: the global `User.role` is not an authorization
      // source. Access is membership (see route-access.ts); the claim below is only
      // a hint for the Edge middleware.
      session.activeOrganizationId = (token.activeOrganizationId as string | null) ?? null;
      // The `{ staff, portal }` claim (derive-access.ts). Absent on a token issued
      // before it existed — the middleware then FAILS CLOSED and forces a re-login.
      session.access = isAccessClaim(token.access) ? token.access : null;
      return session;
    },
  },
} satisfies NextAuthConfig;
