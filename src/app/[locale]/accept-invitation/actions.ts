"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { syncStaffAssignments, STAFF_ROLES, type StaffMembershipRole } from "@/lib/staff/staff-service";
import type { ActionState } from "@/lib/action-state";

const tokenSchema = z.object({ token: z.string().min(1) });
const passwordSchema = z.string().min(8);

/** Thrown inside the transaction when another request consumed the invitation first — rolls everything back. */
class InvitationAlreadyConsumed extends Error {}

/**
 * Accepting an invitation. Same token-consumption idiom as
 * reset-password/actions.ts (hash the submitted token, look up by hash, reject
 * if missing/used/revoked/expired).
 *
 * WHO sets a password is the whole point of the three cases below — this
 * action used to overwrite the password of whichever account owned the invited
 * address, unconditionally, which was right only for the first one:
 *
 * 1. **No account yet** (a staff invitation to a new person): create it with
 *    the password they choose, active, with the invited role.
 * 2. **An unaccepted placeholder** (`active: false` — `approveOrganization`
 *    creates the new Owner's account before they have a password): they set a
 *    real one and the account is activated.
 * 3. **An existing, active account** (someone already in another organization,
 *    or the platform admin invited to their own): the password is NEVER
 *    touched and none is asked for. They gain the membership; that is all.
 *    Nor is a session minted — holding a link proves control of the email
 *    address, not of the account, and the only thing it may grant is the
 *    membership the Owner offered. They sign in with the password they have.
 *
 * The membership (and, for a director/instructor, the academy assignments) is
 * created here, at acceptance — a pending invitation grants nothing. An
 * existing membership is left exactly as it is: an old link can neither
 * change a role nor reactivate someone an Owner has since deactivated.
 */
export async function acceptInvitation(locale: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = tokenSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) {
    return { error: "invalidToken", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const tokenHash = digestLookupSecret(parsed.data.token, requireEnv("CODE_PEPPER"));
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });
  if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
    return { error: "invalidToken" };
  }

  const [existingUser, organization] = await Promise.all([
    prisma.user.findUnique({ where: { email: invitation.email } }),
    prisma.organization.findUniqueOrThrow({ where: { id: invitation.organizationId }, select: { defaultLocale: true } }),
  ]);

  // The global `User.role` gates whole route trees; a student account cannot
  // also be staff (see inviteStaffMember, which refuses this up front).
  if (existingUser?.role === "STUDENT" && invitation.role !== "STUDENT") {
    return { error: "studentAccount" };
  }

  // Only a brand-new account, or an unaccepted placeholder, is asked for a password.
  const needsPassword = !existingUser || !existingUser.active;
  let passwordHash: string | null = null;
  let chosenPassword: string | null = null;
  if (needsPassword) {
    const password = passwordSchema.safeParse(formData.get("password"));
    if (!password.success) {
      return { error: "invalidPassword", fieldErrors: { password: password.error.flatten().formErrors } };
    }
    chosenPassword = password.data;
    passwordHash = await hashSecret(password.data);
  }

  // A director/instructor invitation carries its academies; re-validate them now (never
  // trust the row as still-valid: an academy may have been removed since it was issued).
  const staffRole = (STAFF_ROLES as readonly string[]).includes(invitation.role) ? (invitation.role as StaffMembershipRole) : null;
  const academyIds = staffRole && staffRole !== "ADMIN" ? [...new Set(invitation.academyIds)] : [];
  if (staffRole && staffRole !== "ADMIN") {
    const found = academyIds.length
      ? await prisma.academy.count({ where: { organizationId: invitation.organizationId, id: { in: academyIds } } })
      : 0;
    if (academyIds.length === 0 || found !== academyIds.length) return { error: "invalidToken" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Consume the invitation first and exactly once: two clicks can't both win.
      const consumed = await tx.invitation.updateMany({
        where: { id: invitation.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new InvitationAlreadyConsumed();

      let userId: string;
      if (!existingUser) {
        const created = await tx.user.create({
          data: { email: invitation.email, passwordHash: passwordHash!, role: invitation.role, locale: organization.defaultLocale, active: true },
        });
        userId = created.id;
      } else {
        userId = existingUser.id;
        if (needsPassword) {
          await tx.user.update({ where: { id: userId }, data: { passwordHash: passwordHash!, active: true } });
        }
      }

      const membership = await tx.organizationMembership.findUnique({
        where: { userId_organizationId: { userId, organizationId: invitation.organizationId } },
      });
      const joined =
        membership ??
        (await tx.organizationMembership.create({
          data: { userId, organizationId: invitation.organizationId, role: invitation.role, active: true },
        }));
      if (!membership && staffRole && staffRole !== "ADMIN") {
        await syncStaffAssignments(tx, userId, invitation.organizationId, staffRole, academyIds);
      }

      await tx.auditLog.create({
        data: {
          actorId: userId,
          organizationId: invitation.organizationId,
          action: "staff.accept",
          entityType: "OrganizationMembership",
          entityId: joined.id,
          after: { role: joined.role, academyIds, createdMembership: !membership },
        },
      });
    });
  } catch (error) {
    if (error instanceof InvitationAlreadyConsumed) return { error: "invalidToken" };
    throw error;
  }

  // An existing account is not signed in by a link (case 3).
  if (!needsPassword) return { ok: true };

  try {
    await signIn("credentials", {
      email: invitation.email,
      password: chosenPassword!,
      // The Owner's first stop is the branding wizard; staff go straight to the app.
      redirectTo: `/${locale}/${invitation.role === "ADMIN" ? "onboarding" : "dashboard"}`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Should be unreachable — the password just verified against was
      // written to the DB in the same transaction above — but fail closed
      // rather than crash if it somehow happens.
      return { error: "invalidToken" };
    }
    throw error;
  }

  return {};
}
