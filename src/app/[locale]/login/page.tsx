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
 *
 * `titleClassName` (D2, design/matroom/DESIGN.md §D2) — bare `/login` is
 * the "platform sign-in" surface D2 names as approved for the serif
 * heading, same opt-in mechanism and weight as register-academy
 * (`font-normal`: the vendored Noto Serif file is a single static Regular
 * (400) instance; `CardTitle`'s own `font-medium` would otherwise apply).
 * `/o/[orgSlug]/login` deliberately does NOT pass this — see
 * `login-form.tsx`'s own doc comment for why.
 */
export default function LoginPage() {
  return <LoginForm titleClassName="font-display font-normal" />;
}
