import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

afterEach(() => {
  vi.doUnmock("node:crypto");
  vi.resetModules();
});

describe("generateStudentCode retry-on-collision", () => {
  it("skips a code whose hash already exists in the DB and returns the next candidate", async () => {
    const pepper = requireEnv("CODE_PEPPER");
    const takenCode = "1234";
    const freeCode = "5678";
    const takenHash = digestLookupSecret(takenCode, pepper);

    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const seeded = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        firstName: "Taken",
        lastName: "Code",
        phone: "00000000",
        email: `taken-code-${Date.now()}@example.com`,
        codeHash: takenHash,
      },
    });

    try {
      vi.doMock("node:crypto", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:crypto")>();
        let call = 0;
        return {
          ...actual,
          randomInt: () => {
            call += 1;
            // First attempt collides with the seeded row above; second
            // attempt is free and should be the one actually returned.
            return call === 1 ? Number(takenCode) : Number(freeCode);
          },
        };
      });
      vi.resetModules();

      const { generateStudentCode } = await import("../../src/lib/students/generate-code");
      const result = await generateStudentCode();

      expect(result.code).toBe(freeCode);
      expect(result.codeHash).toBe(digestLookupSecret(freeCode, pepper));

      const stillFree = await prisma.student.findUnique({ where: { codeHash: result.codeHash } });
      expect(stillFree).toBeNull();
    } finally {
      await prisma.student.delete({ where: { id: seeded.id } });
    }
  });
});
