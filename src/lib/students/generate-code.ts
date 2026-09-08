import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

const MAX_ATTEMPTS = 20;

export async function generateStudentCode(): Promise<{ code: string; codeHash: string }> {
  const pepper = requireEnv("CODE_PEPPER");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = randomInt(0, 10000).toString().padStart(4, "0");
    const codeHash = digestLookupSecret(code, pepper);

    const existing = await prisma.student.findUnique({ where: { codeHash } });
    if (!existing) {
      return { code, codeHash };
    }
  }

  throw new Error("Could not generate a unique student code after 20 attempts");
}
