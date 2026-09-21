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

  // `refresh`: a WELL-FORMED claim that denies this tree. The database may now say
  // yes (a promotion while logged in), and this Edge code cannot ask it — so hand the
  // request to the Node refresh route, which re-derives the claim and either
  // continues here or explains the refusal. Never the login page: someone just
  // granted access must not be bounced, or told to log out.
  if (decision === "refresh") {
    const refreshUrl = new URL("/api/access/refresh", req.nextUrl.origin);
    refreshUrl.searchParams.set("to", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(refreshUrl);
  }

  // `login`: no session, or a session with no usable claim (FAIL CLOSED — a token
  // from before the claim existed is forced to re-authenticate). The attempted path
  // is preserved as `callbackUrl`.
  if (decision === "login") {
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
