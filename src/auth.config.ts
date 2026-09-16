import type { NextAuthConfig } from "next-auth";

export default {
  providers: [],
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: string }).role;
        token.activeOrganizationId = null;
      }
      // Set via `unstable_update({ activeOrganizationId })` by whatever
      // organization-switcher action calls it (Phase 5's org switcher UI is
      // the intended caller — MULTI_ACADEMY_AND_KIDS_BELTS.md; the 1f-era
      // `switchActiveOrganization` prototype was removed pending that real
      // UI, per check:guard-usage's zero-callers rule). That caller must
      // re-validate membership before calling this, so the token is never
      // trusted as the source of authority, only as a selector (Appendix C
      // decision 4 / proposal point 1).
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
