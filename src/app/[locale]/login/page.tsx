import { LoginForm } from "./login-form";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — deliberately plain and
 * unbranded. Phase 4's single-organization stopgap here
 * (`resolveSingleOrganizationBranding`) is deleted outright, exactly as
 * promised when it was built: real per-org routing now exists
 * (`/o/[orgSlug]/login`), so bare `/login` no longer needs to guess which
 * organization's branding to show — it's the generic entry point for
 * someone who didn't arrive via their organization's own link. No `brand`
 * prop passed: `LoginForm`/`AuthCard` fall back to the generic platform
 * wordmark, same as before.
 */
export default function LoginPage() {
  return <LoginForm />;
}
