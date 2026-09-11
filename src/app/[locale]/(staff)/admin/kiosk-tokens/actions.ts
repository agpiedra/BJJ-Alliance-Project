"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { requireStaffSession } from "@/lib/auth/session";
import { Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const academyIdSchema = z.object({ academyId: z.string().min(1) });

export type RegenerateKioskTokenState = ActionState & { token?: string };

/**
 * ADMIN-only (spec: this rotates a shared, academy-wide device credential —
 * not a single student's own secret — so it's global-admin territory, not
 * something a DIRECTOR scoped to one academy gets to touch, unlike
 * `regenerateStudentCode`).
 *
 * The submitted `academyId` is never blind-trusted: `findUniqueOrThrow`
 * below re-validates it's a real row before anything is written, the same
 * discipline every other write action in this codebase applies to
 * client-submitted ids.
 *
 * `digestLookupSecret` (keyed HMAC-SHA256), never bcrypt — same reasoning as
 * `Student.codeHash` and `PasswordResetToken.tokenHash`: this hash must
 * support an exact-match DB lookup (Academy.kioskTokenHash is `@unique`,
 * and the kiosk check-in path looks a presented token up by its hash), which
 * bcrypt's random-salt-per-hash design cannot do.
 *
 * The plaintext token is returned exactly once, in this action's return
 * value, and is never persisted or logged anywhere — only its hash is
 * written. Same reasoning as `regenerateStudentCode`'s doc comment: the
 * `AuditLog` row below records only THAT a rotation happened, never the old
 * or new hash, since copying it into an append-only audit table would create
 * a second place the device credential could leak from.
 */
export async function regenerateKioskToken(
  _prevState: RegenerateKioskTokenState,
  formData: FormData,
): Promise<RegenerateKioskTokenState> {
  const session = await requireStaffSession(["ADMIN"]);

  const parsed = academyIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  let academy: { id: string };
  try {
    academy = await prisma.academy.findUniqueOrThrow({
      where: { id: parsed.data.academyId },
      select: { id: true },
    });
  } catch {
    return { error: "notFound" };
  }

  const token = generateRandomToken();
  const kioskTokenHash = digestLookupSecret(token, requireEnv("CODE_PEPPER"));

  // The update and its audit row go in one interactive transaction, so an
  // audit row can never exist without the rotation it describes, nor a
  // rotation happen with no record of who did it.
  await prisma.$transaction(async (tx) => {
    await tx.academy.update({
      where: { id: academy.id },
      data: { kioskTokenHash },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: academy.id,
        action: "academy.regenerateKioskToken",
        entityType: "Academy",
        entityId: academy.id,
        // SQL NULL, not the JSON literal `null` — Prisma rejects a bare JS
        // `null` for a nullable Json column.
        before: Prisma.DbNull,
        after: { regeneratedAt: new Date().toISOString() },
      },
    });
  });

  return { ok: true, token };
}
