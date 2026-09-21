import { redirect } from "next/navigation";
import { auth, unstable_update } from "@/auth";
import { routing } from "@/i18n/routing";
import { sanitizeCallbackUrl } from "@/lib/callback-url";
import { accessFromContext } from "@/lib/auth/derive-access";
import { isAccessClaim, routeAccess, sameAccess, stripLocale } from "@/lib/auth/route-access";
import { getTenantContext } from "@/lib/tenant/context";
import { tenantRedirectPath } from "@/lib/tenant/redirect-path";

// Node runtime (Prisma). Excluded from the middleware matcher (`/api`), so this
// route can never be bounced back through the gate that sent the request here.

/**
 * The answer to "Anny promoted me while I was logged in." The Edge middleware can
 * only REFUSE on the session's `access` claim — it has no database — so when a
 * well-formed claim denies a tree it sends the request here instead of to the login
 * page. This route re-derives access from the DATABASE (`getTenantContext`, the same
 * resolution every page uses):
 *
 * - if the database disagrees with the claim — in EITHER direction — the claim is
 *   rewritten (`unstable_update`), so a promotion takes effect on the next click and
 *   a demotion stops a stale staff claim from asking again;
 * - if the (fresh) access now allows `to`, continue there;
 * - otherwise the person is TOLD, on `/no-access` — never bounced to the login page,
 *   never asked to log out.
 *
 * A session with NO usable claim is not healed here: it FAILS CLOSED to login, so a
 * token from before the claim existed is forced to re-authenticate rather than being
 * quietly upgraded. Tenant-less states (choose an organization, no organization,
 * organization unavailable) go where every page would send them.
 *
 * `to` is a client-controlled query string: only a same-origin relative path is ever
 * followed (`sanitizeCallbackUrl`); anything else is ignored.
 */
export async function GET(request: Request): Promise<never> {
  const requested = new URL(request.url).searchParams.get("to") ?? undefined;
  const to = sanitizeCallbackUrl(requested);
  const localeMatch = to?.match(/^\/(es|en)(\/|$|\?)/);
  const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;

  const session = await auth();
  if (!session?.user?.id || !isAccessClaim(session.access)) {
    redirect(`/${locale}/login${to ? `?callbackUrl=${encodeURIComponent(to)}` : ""}`);
  }

  const result = await getTenantContext();
  if (result.status !== "OK") {
    redirect(tenantRedirectPath(result.status, locale));
  }

  const derived = accessFromContext(result.context);
  if (!sameAccess(session.access, derived)) {
    // Any session update makes the jwt callback re-derive the claim for the active
    // organization (sign-in-jwt-callback.ts); naming it also heals a token that had none.
    await unstable_update({ activeOrganizationId: result.context.organizationId });
  }

  if (to && routeAccess(stripLocale(to.split("?")[0]), true, derived) === "allow") {
    redirect(to);
  }
  redirect(`/${locale}/no-access`);
}
