import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import authConfig from "@/auth.config";

const { auth } = NextAuth(authConfig);
const handleI18nRouting = createMiddleware(routing);

const STAFF_PREFIXES = ["/dashboard", "/students", "/admin"];
const STUDENT_PREFIXES = ["/portal"];

function stripLocale(pathname: string): string {
  const match = pathname.match(/^\/(es|en)(\/.*)?$/);
  return match ? (match[2] ?? "/") : pathname;
}

export default auth((req) => {
  const pathWithoutLocale = stripLocale(req.nextUrl.pathname);
  const isStaffPrefix = STAFF_PREFIXES.some((prefix) => pathWithoutLocale.startsWith(prefix));
  const isStudentPrefix = STUDENT_PREFIXES.some((prefix) => pathWithoutLocale.startsWith(prefix));

  if (isStaffPrefix || isStudentPrefix) {
    const role = req.auth?.user?.role;
    const isStaff = role === "ADMIN" || role === "DIRECTOR" || role === "INSTRUCTOR";
    const isStudent = role === "STUDENT";
    // Each route tree requires its own role — a staff session hitting
    // `/portal` is just as unauthorized there as a student hitting
    // `/dashboard`/`/students`/`/admin` is on the staff prefixes. Both send
    // the caller to the same `/login` (with the attempted path preserved as
    // `callbackUrl`) rather than silently redirecting them into their own
    // route tree — symmetric with how a wrong-role staff session is already
    // handled here today.
    const authorized = isStaffPrefix ? isStaff : isStudent;
    if (!authorized) {
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
