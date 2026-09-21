import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import authConfig from "@/auth.config";
import { routeAccess, stripLocale } from "@/lib/auth/route-access";

const { auth } = NextAuth(authConfig);
const handleI18nRouting = createMiddleware(routing);

/**
 * The Edge gate. It reads ONLY the session's `access` claim (`{ staff, portal }`,
 * derived from the database at sign-in and on organization switch) and applies the
 * pure decision in `route-access.ts`. It can refuse; it cannot grant: every page
 * re-derives access from the database, so a forged or stale claim that passes here
 * is stopped there. It never reads the global `User.role`.
 */
export default auth((req) => {
  const decision = routeAccess(stripLocale(req.nextUrl.pathname), Boolean(req.auth?.user?.id), req.auth?.access);

  // `login`: no session, or a session with no usable claim (fail closed — forces a
  // re-login). `refresh` (a well-formed claim that denies this tree) also lands here
  // until the refresh route exists; the attempted path is preserved as `callbackUrl`.
  if (decision !== "allow") {
    const localeMatch = req.nextUrl.pathname.match(/^\/(es|en)/);
    const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;
    const loginUrl = new URL(`/${locale}/login`, req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return handleI18nRouting(req);
});

export const config = {
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
