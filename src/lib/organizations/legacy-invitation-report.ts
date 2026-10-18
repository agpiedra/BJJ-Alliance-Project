import { prisma } from "@/lib/prisma";

/** How close a sibling's creation must be to a legacy row's `usedAt` to be reported as an observed successor. */
export const SUCCESSOR_WINDOW_MS = 5_000;

export const SUCCESSOR_OBSERVATION_NOTE =
  "observation only — consistent with supersession by the old approve/resend path, also consistent with an acceptance " +
  "racing a resend under the old code; proves neither";

export interface LegacyInvitationOrganizationReport {
  organizationId: string;
  /** Rows with `usedAt` set, no `acceptedAt`, no `revokedAt`: accepted OR superseded under the old rules — unknowable. */
  legacyUsedCount: number;
  /** Unused, unrevoked, unexpired invitations for the organization right now. */
  liveInvitationCount: number;
  earliestUsedAt: Date;
  latestUsedAt: Date;
  /** Legacy rows with a sibling (same address) created within SUCCESSOR_WINDOW_MS of their `usedAt`. See the note. */
  successorObservedCount: number;
}

/**
 * docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md §6.3 — a READ-ONLY report of the legacy-used invitations that block a
 * platform resend. Runs in a `READ ONLY` transaction, so it cannot write even by mistake. Reports organization ids and
 * counts only — never an address, token hash or link. It classifies nothing and repairs nothing: any historical repair
 * is a separate, reviewed, per-organization step.
 */
export async function reportLegacyInvitations(): Promise<LegacyInvitationOrganizationReport[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;

    const legacy = await tx.invitation.findMany({
      where: { usedAt: { not: null }, acceptedAt: null, revokedAt: null },
      select: { id: true, organizationId: true, email: true, usedAt: true },
    });
    if (legacy.length === 0) return [];

    const organizationIds = [...new Set(legacy.map((row) => row.organizationId))].sort();
    const all = await tx.invitation.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { id: true, organizationId: true, email: true, createdAt: true, usedAt: true, revokedAt: true, expiresAt: true },
    });
    const now = Date.now();

    return organizationIds.map((organizationId) => {
      const rows = legacy.filter((row) => row.organizationId === organizationId);
      const siblings = all.filter((row) => row.organizationId === organizationId);
      const usedTimes = rows.map((row) => row.usedAt!.getTime());
      return {
        organizationId,
        legacyUsedCount: rows.length,
        liveInvitationCount: siblings.filter((row) => !row.usedAt && !row.revokedAt && row.expiresAt.getTime() > now).length,
        earliestUsedAt: new Date(Math.min(...usedTimes)),
        latestUsedAt: new Date(Math.max(...usedTimes)),
        successorObservedCount: rows.filter((row) =>
          siblings.some(
            (other) =>
              other.id !== row.id &&
              other.email.toLowerCase() === row.email.toLowerCase() &&
              Math.abs(other.createdAt.getTime() - row.usedAt!.getTime()) <= SUCCESSOR_WINDOW_MS,
          ),
        ).length,
      };
    });
  });
}
