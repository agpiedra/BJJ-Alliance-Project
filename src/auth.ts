import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import authConfig from "@/auth.config";
import { verifyCredentials } from "@/lib/auth/verify-credentials";
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
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }
        return verifyCredentials(email, password);
      },
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
