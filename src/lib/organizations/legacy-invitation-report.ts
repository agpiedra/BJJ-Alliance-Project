import { prisma } from "@/lib/prisma";
import { ACCEPTED, LEGACY_USED, sameRecipient } from "@/lib/organizations/approve-organization";

/** How close a sibling's creation must be to a legacy row's `usedAt` to be reported as an observed successor. */
export const SUCCESSOR_WINDOW_MS = 5_000;

export const SUCCESSOR_OBSERVATION_NOTE =
  "observation only — consistent with supersession by the old approve/resend path, also consistent with an acceptance " +
  "racing a resend under the old code; proves neither";

/** An organization whose platform owner resend is blocked right now (`legacyUnresolved`), and why. */
export interface OwnerResendBlocker {
  organizationId: string;
  /** Legacy-used rows for the owner's contact address: accepted OR superseded under the old rules — unknowable. */
  legacyUsedCount: number;
  /** Unused, unrevoked, unexpired invitations to the owner's contact address right now (still acceptable). */
  liveInvitationCount: number;
  earliestUsedAt: Date;
  latestUsedAt: Date;
  /** Legacy rows with a sibling to the same address created within SUCCESSOR_WINDOW_MS of their `usedAt`. See the note. */
  successorObservedCount: number;
}

/**
 * docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md §6.3 — a READ-ONLY report of the organizations whose platform owner resend
 * returns `legacyUnresolved`, decided with the SAME predicates approveOrganization uses: an organization approveOrganization
 * would run for (PENDING or ACTIVE, with a contact address), a legacy-used invitation to that exact address
 * (`sameRecipient` + `LEGACY_USED`), and no genuinely accepted one (`ACCEPTED` takes precedence: it short-circuits to
 * "already accepted"). Legacy rows for any other address — a staff invitation, a case-variant account — never block the
 * owner resend and are not reported.
 *
 * Runs in a `READ ONLY` transaction, so it cannot write even by mistake. Reports organization ids and counts only — never
 * an address, token hash or link. It classifies nothing and repairs nothing.
 */
export async function reportOwnerResendBlockers(): Promise<OwnerResendBlocker[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;

    const organizations = await tx.organization.findMany({
      where: { status: { in: ["PENDING", "ACTIVE"] }, contactEmail: { not: null } },
      select: { id: true, contactEmail: true },
      orderBy: { id: "asc" },
    });
    const now = Date.now();
    const blockers: OwnerResendBlocker[] = [];

    for (const organization of organizations) {
      const owner = sameRecipient(organization.id, organization.contactEmail!);
      const legacy = await tx.invitation.findMany({ where: { ...owner, ...LEGACY_USED }, select: { id: true, usedAt: true } });
      if (legacy.length === 0) continue;
      if (await tx.invitation.findFirst({ where: { ...owner, ...ACCEPTED }, select: { id: true } })) continue;

      const siblings = await tx.invitation.findMany({ where: owner, select: { id: true, createdAt: true, usedAt: true, revokedAt: true, expiresAt: true } });
      const usedTimes = legacy.map((row) => row.usedAt!.getTime());
      blockers.push({
        organizationId: organization.id,
        legacyUsedCount: legacy.length,
        liveInvitationCount: siblings.filter((row) => !row.usedAt && !row.revokedAt && row.expiresAt.getTime() > now).length,
        earliestUsedAt: new Date(Math.min(...usedTimes)),
        latestUsedAt: new Date(Math.max(...usedTimes)),
        successorObservedCount: legacy.filter((row) =>
          siblings.some((other) => other.id !== row.id && Math.abs(other.createdAt.getTime() - row.usedAt!.getTime()) <= SUCCESSOR_WINDOW_MS),
        ).length,
      });
    }
    return blockers;
  });
}
