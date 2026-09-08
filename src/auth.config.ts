import type { NextAuthConfig } from "next-auth";

export default {
  providers: [],
  pages: {
    signIn: "/login",
  },
  trustHost: true,
} satisfies NextAuthConfig;
