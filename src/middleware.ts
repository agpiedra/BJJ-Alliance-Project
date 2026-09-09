import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import authConfig from "@/auth.config";

const { auth } = NextAuth(authConfig);
const handleI18nRouting = createMiddleware(routing);

const PROTECTED_PREFIXES = ["/dashboard", "/students", "/admin"];

function stripLocale(pathname: string): string {
  const match = pathname.match(/^\/(es|en)(\/.*)?$/);
  return match ? (match[2] ?? "/") : pathname;
}

export default auth((req) => {
  const pathWithoutLocale = stripLocale(req.nextUrl.pathname);
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathWithoutLocale.startsWith(prefix));

  if (isProtected) {
    const role = req.auth?.user?.role;
    const isStaff = role === "ADMIN" || role === "DIRECTOR" || role === "INSTRUCTOR";
    if (!isStaff) {
      const localeMatch = req.nextUrl.pathname.match(/^\/(es|en)/);
      const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;
      const loginUrl = new URL(`/${locale}/login`, req.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return handleI18nRouting(req);
});

export const config = {
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
