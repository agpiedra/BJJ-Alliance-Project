import { BrandBanner } from "@/components/brand/brand-banner";
import { resolveSingleOrganizationBranding } from "@/lib/tenant/platform-lookups";
import { LoginForm } from "./login-form";

// The single-org branding lookup can change without a redeploy (a director
// finishing their branding, or a second organization onboarding) — never
// statically cached.
export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — a generic login leading into a
 * fully branded app read as unfinished ("the first screen the director sees
 * in the demo"). Full per-org login branding needs routing that doesn't
 * exist until Phase 5 (no org slug/subdomain in the URL today — verified
 * directly in middleware.ts), so this is deliberately NOT that: with
 * exactly one organization on the platform, its branding is unambiguous
 * even pre-auth, and `resolveSingleOrganizationBranding` returns `null` the
 * moment a second one exists — no manual removal step needed, though the
 * whole thing should be deleted outright once Phase 5's real per-org
 * routing lands, rather than kept as permanently-dead code.
 */
export default async function LoginPage() {
  const branding = await resolveSingleOrganizationBranding();

  return (
    <>
      <BrandBanner
        logoUrl={branding?.logoUrl}
        initials={branding?.initials}
        initialsBackground={branding?.sidebar.background}
        initialsForeground={branding?.sidebar.foreground}
      />
      <LoginForm />
    </>
  );
}
