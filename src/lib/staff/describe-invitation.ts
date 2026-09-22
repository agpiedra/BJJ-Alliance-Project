import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

export type InvitationSummary =
  | { valid: false }
  | {
      valid: true;
      /** "setPassword": a brand-new account or an unaccepted placeholder chooses one.
       * "join": the person already has an account — its password is never touched and none is asked for. */
      mode: "setPassword" | "join";
      organizationName: string;
      role: string;
      /** The visitor's own session belongs to the person invited. Decided here, where the invitation's
       * email is known, so the email itself never goes to the page. */
      alreadySignedIn: boolean;
    };

/**
 * What the accept page needs to know about a link, so it shows a password field
 * only when one is actually needed. Deliberately reveals nothing beyond what
 * the holder of a valid link already has (the organization it is for, the role
 * offered, and whether they must choose a password): an invalid, used, revoked
 * or expired link is just `{ valid: false }`, with no hint which.
 *
 * MUST agree with `acceptInvitation` on who needs a password — the rule
 * (`!user || !user.active`) is stated in both places and pinned by
 * tests/integration/describe-invitation.test.ts.
 */
export async function describeInvitation(token: string, sessionEmail?: string | null): Promise<InvitationSummary> {
  if (!token) return { valid: false };
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: digestLookupSecret(token, requireEnv("CODE_PEPPER")) },
    select: {
      email: true,
      role: true,
      usedAt: true,
      revokedAt: true,
      expiresAt: true,
      organization: { select: { name: true } },
    },
  });
  if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
    return { valid: false };
  }

  const user = await prisma.user.findUnique({ where: { email: invitation.email }, select: { active: true } });
  return {
    valid: true,
    mode: !user || !user.active ? "setPassword" : "join",
    organizationName: invitation.organization.name,
    role: invitation.role,
    alreadySignedIn: Boolean(sessionEmail) && sessionEmail!.toLowerCase() === invitation.email.toLowerCase(),
  };
}
