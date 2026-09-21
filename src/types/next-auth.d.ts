import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
    /**
     * MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C decision 4: the selector for
     * which organization the user currently wants — never authority on its
     * own. `src/lib/tenant/context.ts` re-validates it against a real
     * `OrganizationMembership` row on every request; a stale or tampered
     * value here fails closed, it never grants access by itself.
     */
    activeOrganizationId: string | null;
    /**
     * `{ staff, portal }`, derived from the database for `activeOrganizationId` at
     * sign-in and on organization switch (`src/lib/auth/derive-access.ts`). A HINT
     * for the Edge middleware — which can refuse on it but never grant — never
     * authority: pages re-derive access from the database on every request. `null`
     * for a token issued before the claim existed (the middleware fails closed).
     */
    access: import("@/lib/auth/route-access").AccessClaim | null;
  }

  interface User {
    id: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    activeOrganizationId: string | null;
    access?: import("@/lib/auth/route-access").AccessClaim;
  }
}
