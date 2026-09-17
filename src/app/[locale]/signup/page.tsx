import { unscopedPrisma } from "@/lib/prisma/unscoped";
import { BrandBanner } from "@/components/brand/brand-banner";
import { SignupForm } from "./signup-form";

// The academy list is queried live, not baked into the build: unlike
// force-static routes here, this page reads a DB table an admin could
// change without a redeploy, so it must not be frozen at build time.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  // Explicit escape hatch, not a tenant-scoped query: this page is public
  // and unauthenticated, before any organization is known. Revision 23
  // (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md) found it querying EVERY active
  // academy across EVERY organization with no auth at all — a full
  // cross-org leak to anonymous visitors. This whole self-signup flow is
  // single-organization already: `actions.ts`'s own `homeAcademySlug`
  // validation is a hardcoded `z.enum(["escazu", "escalante"])`, not a real
  // multi-tenant selector (a genuine multi-org self-signup design is Phase
  // 8 territory per that file's own comment). Restricting this list to
  // those same two academies closes the leak without pretending to fix the
  // deeper single-org hardcoding, which this one query can't fix alone.
  const academies = await unscopedPrisma.academy.findMany({
    where: { active: true, slug: { in: ["escazu", "escalante"] } },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  return (
    <>
      <BrandBanner />
      <SignupForm academies={academies} />
    </>
  );
}
