import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";
import { runReadOnly } from "../../scripts/lib/read-only-transaction";

const prisma = getTestPrismaClient();

describe("runReadOnly", () => {
  it("verifies transaction_read_only is on before running the callback", async () => {
    let sawFlag: string | undefined;
    await runReadOnly(prisma, async (tx) => {
      const [{ transaction_read_only }] = await tx.$queryRawUnsafe<Array<{ transaction_read_only: string }>>(
        "SHOW transaction_read_only",
      );
      sawFlag = transaction_read_only;
    });
    expect(sawFlag).toBe("on");
  });

  it("rejects a write attempted inside the transaction — at the database level, not by convention", async () => {
    await expect(
      runReadOnly(prisma, async (tx) => {
        await tx.academy.update({
          where: { slug: "escazu" },
          data: { name: "should never be written" },
        });
      }),
    ).rejects.toThrow(/read-only transaction/i);

    // The rejected write left no trace.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    expect(escazu.name).toBe("Alliance Escazú");
  });

  it("rejects a raw-SQL write attempted inside the transaction", async () => {
    await expect(
      runReadOnly(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "Academy" SET name = 'nope' WHERE slug = 'escazu'`);
      }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
