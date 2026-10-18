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
import { approveOrganization, type ApproveOrganizationResult } from "../src/lib/organizations/approve-organization";

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

  // The manual-link fallback: a rejected or unconfigured send keeps the new link live so it can be shared by hand.
  const result = await approveOrganization(slug, approver.id, { keepLinkOnFailedSend: true });

  console.log(`Organization "${slug}" approved.`);
  console.log(`  Default academy slug: ${result.academySlug}`);
  if (result.kioskToken) {
    console.log(`  Kiosk token (shown once, save it now): ${result.kioskToken}`);
  } else {
    console.log("  Academy already existed — no new kiosk token minted.");
  }
  for (const line of invitationLines(result)) console.log(`  ${line}`);
}

/** What happened to the invitation, claiming nothing beyond what approveOrganization actually knows. */
function invitationLines(result: ApproveOrganizationResult): string[] {
  if (result.invitationIssue === "alreadyAccepted") return ["The owner already accepted an invitation — no new one issued."];
  if (result.invitationIssue === "legacyUnresolved") {
    return [
      "An earlier invitation is recorded as used under the previous rules (accepted or replaced: unknown) — no new one issued.",
      "Run scripts/report-legacy-invitations.ts; any repair is a separate, reviewed step.",
    ];
  }
  const email = {
    accepted: "Invitation email accepted by the provider (delivery not confirmed).",
    rejected: "Invitation email NOT sent: the provider rejected it.",
    not_configured: "Invitation email NOT sent: email sending is not configured.",
    unknown: "Invitation email could not be confirmed as sent.",
  }[result.invitationEmailOutcome!];
  switch (result.invitationSettlement) {
    case "settled":
      return [
        `Invitation link: ${result.invitationLink}`,
        email,
        result.invitationEmailOutcome === "accepted"
          ? "Earlier links for this address retired."
          : result.invitationEmailOutcome === "unknown"
            ? "Earlier links not changed; the first invitation accepted ends the others."
            : "Share the link above manually; it stays valid. Earlier links not changed.",
      ];
    case "acceptedMeanwhile":
      return [email, "An invitation to this address was accepted meanwhile — no further invitation needed; the new link is not shown."];
    case "unavailable":
      return [email, "The new invitation is no longer available, so its link is not shown. Earlier links not changed."];
    default:
      return [
        `Invitation link (may not work): ${result.invitationLink}`,
        email,
        "Invitation records could not be updated after sending — earlier links may still work.",
      ];
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
