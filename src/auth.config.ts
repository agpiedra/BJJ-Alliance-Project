import type { NextAuthConfig } from "next-auth";

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
      // `user` here only carries id/role — the DB-backed
      // `activeOrganizationId` resolution lives entirely in src/auth.ts's
      // own `jwt` callback override, which wraps this one.
      if (user) {
        token.id = user.id;
        token.role = (user as { role: string }).role;
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
      session.user.role = token.role as string;
      session.activeOrganizationId = (token.activeOrganizationId as string | null) ?? null;
      return session;
    },
  },
} satisfies NextAuthConfig;
