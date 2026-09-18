import { BrandBanner } from "@/components/brand/brand-banner";
import { resolveOrganizationLoginBranding } from "@/lib/tenant/platform-lookups";
import { LoginForm } from "../../../login/login-form";

// The branding lookup can change without a redeploy (a director editing
// their theme/logo, an organization's approval status changing) — never
// statically cached.
export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — real per-org login branding,
 * reached via a path segment (`/o/[orgSlug]/login`), never a subdomain:
 * a subdomain needs wildcard DNS and a wildcard cert, which means choosing
 * a hosting provider before one is picked (Global rules: "the production
 * database provider is not chosen yet... nothing is in production"). A path
 * segment needs none of that and mirrors this codebase's own existing
 * `/kiosk/[academySlug]` pattern exactly.
 *
 * `orgSlug` IS A PRE-AUTH DISPLAY SIGNAL ONLY, NEVER AN AUTHORIZATION
 * INPUT. It decides what's shown on this page before any credentials are
 * submitted. `LoginForm` below is entirely unmodified — the same
 * `signIn()` call bare `/login` uses — and organization membership is
 * still resolved AFTER authentication, entirely from the verified user
 * identity (never from this URL segment). A visitor who submits real
 * credentials for a DIFFERENT organization on this page still logs in
 * successfully into their own real organization; this slug never scopes,
 * gates, or otherwise influences that resolution. Do not turn this into a
 * scoping key.
 *
 * `resolveOrganizationLoginBranding` returns `null` for an unknown slug AND
 * for a PENDING/SUSPENDED/CANCELLED organization, deliberately the same
 * `null` for all three — an anonymous visitor is "not yet a member" by this
 * project's own disclosure rule, so non-ACTIVE organization state is never
 * revealed pre-auth. `null` renders the exact same neutral login as bare
 * `/login`.
 */
export default async function OrganizationLoginPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const branding = await resolveOrganizationLoginBranding(orgSlug);

  return (
    <>
      <BrandBanner
        logoUrl={branding?.logoUrl}
        initials={branding?.initials}
        initialsBackground={branding?.sidebar.background}
        initialsForeground={branding?.sidebar.foreground}
        alt={branding?.displayName}
      />
      <LoginForm />
    </>
  );
}
