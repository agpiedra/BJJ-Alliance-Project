/**
 * docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md §6.3 — READ-ONLY. Lists the organizations whose platform "Resend
 * invitation" is blocked by a legacy-used invitation (consumed before `Invitation.acceptedAt` existed, so accepted or
 * superseded — unknowable). Prints organization ids and counts only. Writes nothing; repairs nothing.
 *
 * Affected organizations stay blocked from resending until each is individually resolved by a separately authorized,
 * reviewed repair. Nothing printed here is evidence enough to make that decision on its own.
 *
 * Usage: pnpm exec tsx scripts/report-legacy-invitations.ts
 */
import "dotenv/config";
import { reportLegacyInvitations, SUCCESSOR_OBSERVATION_NOTE, SUCCESSOR_WINDOW_MS } from "../src/lib/organizations/legacy-invitation-report";

async function main() {
  const report = await reportLegacyInvitations();
  if (report.length === 0) {
    console.log("No legacy-used invitations. No organization is blocked by one.");
    return;
  }
  console.log(`${report.length} organization(s) with legacy-used invitations (resend blocked until individually resolved):`);
  for (const row of report) {
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
