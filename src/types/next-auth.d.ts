import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession["user"];
    /**
     * MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C decision 4: the selector for
     * which organization the user currently wants — never authority on its
     * own. `src/lib/tenant/context.ts` re-validates it against a real
     * `OrganizationMembership` row on every request; a stale or tampered
     * value here fails closed, it never grants access by itself.
     */
    activeOrganizationId: string | null;
  }

  interface User {
    role: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: string;
    activeOrganizationId: string | null;
  }
}
