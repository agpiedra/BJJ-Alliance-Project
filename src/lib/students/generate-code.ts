import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

const MAX_ATTEMPTS = 20;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1: "Replace global student code-hash
 * uniqueness with organization-scoped uniqueness." Uniqueness is checked
 * within `organizationId` only — the same 4-digit code can exist in two
 * different organizations without colliding.
 */
export async function generateStudentCode(organizationId: string): Promise<{ code: string; codeHash: string }> {
  const pepper = requireEnv("CODE_PEPPER");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = randomInt(0, 10000).toString().padStart(4, "0");
    const codeHash = digestLookupSecret(code, pepper);

    const existing = await prisma.student.findUnique({
      where: { organizationId_codeHash: { organizationId, codeHash } },
    });
    if (!existing) {
      return { code, codeHash };
    }
  }

  throw new Error("Could not generate a unique student code after 20 attempts");
}
