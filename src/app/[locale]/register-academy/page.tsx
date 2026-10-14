import { RegistrationForm } from "./registration-form";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — public, unauthenticated,
 * genuinely organization-agnostic (there is no organization yet). No
 * `brand` prop passed through to `AuthCard` (via `RegistrationForm`) — same
 * as bare `/login` — there is nothing to brand this page with; it is the
 * page where an organization is born. No separate `<BrandBanner />`: the
 * approved prototype (design/matroom/preview/auth-access-phase-prototype.html)
 * places the wordmark inside the card as part of "the outer card shell",
 * not a second copy in a top banner — `AuthCard`'s own `LogoMark` is this
 * page's only wordmark, matching `/login`'s existing pattern.
 */
export default function RegisterAcademyPage() {
  return <RegistrationForm />;
}
