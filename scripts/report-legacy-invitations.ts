/**
 * docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md §6.3 — READ-ONLY. Lists the organizations whose platform owner "Resend
 * invitation" is blocked right now by a legacy-used invitation (consumed before `Invitation.acceptedAt` existed, so
 * accepted or superseded — unknowable), decided with the same predicates the application uses. Legacy rows for any other
 * address (a staff invitation, a case-variant account) do not block the owner resend and are not listed. Prints
 * organization ids and counts only. Writes nothing; repairs nothing.
 *
 * Listed organizations stay blocked until each is individually resolved by a separately authorized, reviewed repair.
 * Nothing printed here is evidence enough to make that decision on its own.
 *
 * Usage: pnpm exec tsx scripts/report-legacy-invitations.ts
 */
import "dotenv/config";
import { reportOwnerResendBlockers, SUCCESSOR_OBSERVATION_NOTE, SUCCESSOR_WINDOW_MS } from "../src/lib/organizations/legacy-invitation-report";

async function main() {
  const blockers = await reportOwnerResendBlockers();
  if (blockers.length === 0) {
    console.log("No organization's owner resend is blocked by a legacy-used invitation.");
    return;
  }
  console.log(`${blockers.length} organization(s) whose owner resend is blocked by a legacy-used invitation to the contact address:`);
  for (const row of blockers) {
    console.log(
      `  ${row.organizationId}: legacyUsed=${row.legacyUsedCount} live=${row.liveInvitationCount} ` +
        `usedAt=${row.earliestUsedAt.toISOString()}..${row.latestUsedAt.toISOString()} successorObserved=${row.successorObservedCount}`,
    );
  }
  console.log(`successorObserved (sibling created within ${SUCCESSOR_WINDOW_MS / 1000}s of usedAt): ${SUCCESSOR_OBSERVATION_NOTE}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
