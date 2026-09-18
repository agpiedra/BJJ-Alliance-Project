import { BrandBanner } from "@/components/brand/brand-banner";
import { RegistrationForm } from "./registration-form";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — public, unauthenticated,
 * genuinely organization-agnostic (there is no organization yet). Plain
 * `<BrandBanner />` with no props, same as bare `/login` — there is nothing
 * to brand this page with; it is the page where an organization is born.
 */
export default function RegisterAcademyPage() {
  return (
    <>
      <BrandBanner />
      <RegistrationForm />
    </>
  );
}
