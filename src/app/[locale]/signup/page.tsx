import { listSignupAcademies } from "@/lib/tenant/platform-lookups";
import { BrandBanner } from "@/components/brand/brand-banner";
import { SignupForm } from "./signup-form";

// The academy list is queried live, not baked into the build: unlike
// force-static routes here, this page reads a DB table an admin could
// change without a redeploy, so it must not be frozen at build time.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  // Revision 23 found this page querying EVERY active academy across EVERY
  // organization with no auth at all — a full cross-org leak to anonymous
  // visitors. See platform-lookups.ts's listSignupAcademies for why it's
  // restricted to Alliance's two hardcoded academies rather than made
  // organization-scoped (this page is public, before any organization is
  // known).
  const academies = await listSignupAcademies();

  return (
    <>
      <BrandBanner />
      <SignupForm academies={academies} />
    </>
  );
}
