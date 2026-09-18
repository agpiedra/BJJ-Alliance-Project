"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — same token-consumption idiom as
 * reset-password/actions.ts (hash the submitted token, look up by hash,
 * reject if missing/used/expired), reusing PasswordResetToken's own proven
 * pattern (never the table itself — see Invitation's own schema doc
 * comment for why it's a separate table).
 *
 * approveOrganization() already created the OrganizationMembership at
 * approval time — this action's only job is to turn a placeholder,
 * unguessable password into a real one the director actually knows, and
 * activate the account. It then signs them in for real, through the exact
 * same credentials provider `login/actions.ts` uses (never a bespoke
 * "trust me" session-minting path) — the password we just verified against
 * was written to the DB in the same transaction one line above, so
 * re-authenticating against it here is not a race, and this reuses
 * `login/actions.ts`'s own documented fix: `signIn()` must carry out its
 * own redirect (never `redirect: false`), because that internal redirect is
 * what actually attaches the session cookie to the response.
 */
export async function acceptInvitation(locale: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = schema.safeParse({ token: formData.get("token"), password: formData.get("password") });
  if (!parsed.success) {
    return { error: "invalidToken", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const tokenHash = digestLookupSecret(parsed.data.token, requireEnv("CODE_PEPPER"));
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });
  if (!invitation || invitation.usedAt || invitation.expiresAt < new Date()) {
    return { error: "invalidToken" };
  }

  const user = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (!user) {
    // Structural invariant: approveOrganization() always creates or reuses
    // the User before issuing an Invitation for its email. A miss here
    // means real data corruption, not a normal user-facing case.
    throw new Error(`accept-invitation: no User found for invitation email "${invitation.email}".`);
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret(parsed.data.password), active: true },
    }),
    prisma.invitation.update({ where: { id: invitation.id }, data: { usedAt: new Date() } }),
  ]);

  try {
    await signIn("credentials", {
      email: invitation.email,
      password: parsed.data.password,
      redirectTo: `/${locale}/onboarding`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Should be unreachable — the password just verified against was
      // written to the DB one statement above — but fail closed rather
      // than crash if it somehow happens.
      return { error: "invalidToken" };
    }
    throw error;
  }

  return {};
}
