/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — the CLI stand-in for Phase 6's
 * not-yet-built admin approval UI. Without this, a registered organization
 * can never be approved and the registration -> approval -> invitation ->
 * onboarding flow can't be exercised end to end.
 *
 * Calls the exact same approveOrganization() function a real UI will call
 * later — this script owns argument parsing and console output only, never
 * a second copy of the approval logic.
 *
 * Usage:
 *   pnpm exec tsx scripts/approve-organization.ts --slug=alliance-cr --approved-by=admin@example.com
 *
 * --approved-by must name a real, active User with isSuperAdmin: true —
 * approving an organization is a platform-level action (Appendix C
 * decision 5's own "platform-wide grant, explicitly bootstrapped"), not
 * something a regular org ADMIN has standing to do for organizations they
 * don't belong to yet.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { approveOrganization } from "../src/lib/organizations/approve-organization";

function readFlag(name: string): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag?.slice(`--${name}=`.length);
}

async function main() {
  const slug = readFlag("slug");
  const approvedByEmail = readFlag("approved-by");

  if (!slug || !approvedByEmail) {
    console.error("Usage: tsx scripts/approve-organization.ts --slug=<org-slug> --approved-by=<super-admin-email>");
    process.exit(1);
  }

  const approver = await prisma.user.findUnique({ where: { email: approvedByEmail } });
  if (!approver || !approver.active || !approver.isSuperAdmin) {
    console.error(
      `--approved-by="${approvedByEmail}" does not name a real, active, isSuperAdmin user. Refusing to approve.`,
    );
    process.exit(1);
  }

  const result = await approveOrganization(slug, approver.id);

  console.log(`Organization "${slug}" approved.`);
  console.log(`  Default academy slug: ${result.academySlug}`);
  if (result.kioskToken) {
    console.log(`  Kiosk token (shown once, save it now): ${result.kioskToken}`);
  } else {
    console.log("  Academy already existed — no new kiosk token minted.");
  }
  if (result.invitationLink) {
    console.log(`  Invitation link: ${result.invitationLink}`);
    console.log(`  Invitation email sent: ${result.invitationEmailSent ? "yes" : "no — see logged error above, share the link above manually"}`);
  } else {
    console.log("  The director already accepted a prior invitation — no new one issued.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
