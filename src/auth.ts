import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import authConfig from "@/auth.config";
import { authorizeCredentials } from "@/lib/auth/login-throttle";
import { signInJwtCallback } from "@/lib/auth/sign-in-jwt-callback";

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      // The single login-throttle enforcement point: every password check, including a direct POST to
      // /api/auth/callback/credentials, comes through here (docs/LOGIN_THROTTLING_PLAN.md).
      authorize: authorizeCredentials,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // DB-backed activeOrganizationId resolution, deliberately kept OUT of
    // authConfig itself so src/middleware.ts's Edge-runtime NextAuth
    // instance never imports Prisma — see sign-in-jwt-callback.ts's own
    // comment for why this is the SAME function the e2e bypass route uses.
    jwt: signInJwtCallback,
  },
});
