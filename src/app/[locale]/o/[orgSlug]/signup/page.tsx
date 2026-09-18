import { notFound } from "next/navigation";
import { resolveOrganizationForSignup } from "@/lib/tenant/platform-lookups";
import { BrandBanner } from "@/components/brand/brand-banner";
import { SignupForm } from "./signup-form";

// The organization/academy list is queried live, not baked into the build —
// an admin approving a new organization or toggling an academy's active
// state must be reflected without a redeploy.
export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — replaces bare `/signup`
 * outright. That route's academy dropdown was hardcoded to
 * `z.enum(["escazu", "escalante"])` (Alliance's own two academies) as a
 * deliberate stopgap after revision 23 found its unrestricted predecessor
 * leaking every academy across every organization to anonymous visitors.
 * The stopgap breaks the moment a second organization exists — its
 * students would see Alliance's academies in their own signup dropdown.
 * This route closes that: the organization is now explicit in the URL
 * (`orgSlug`), so the academy list can be genuinely scoped by it instead of
 * a hardcoded allowlist.
 *
 * Unlike `/o/[orgSlug]/login`, there is no safe neutral fallback for an
 * unknown or non-ACTIVE organization slug — signup has nothing generic to
 * offer ("sign up" requires a real organization to join). `notFound()`
 * here, same as any other unmatched route, discloses nothing more than
 * "page not found."
 */
export default async function OrganizationSignupPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const organization = await resolveOrganizationForSignup(orgSlug);
  if (!organization) {
    notFound();
  }

  return (
    <>
      <BrandBanner />
      <SignupForm orgSlug={orgSlug} academies={organization.academies} />
    </>
  );
}
