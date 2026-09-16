import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getScopedDb, CrossTenantAccessError } from "../../src/lib/tenant/scoped-client";
import type { SystemJobContext } from "../../src/lib/tenant/types";

const prisma = getTestPrismaClient();

const ESCAZU_ID = "seed-academy-escazu"; // real seeded academy under Alliance — connect TARGET only, to prove cross-org connect fails

const ORG_A = "scoped-client-test-org-a";
const ORG_B = "scoped-client-test-org-b";
const ACADEMY_B = "scoped-client-test-academy-b";

function ctxFor(organizationId: string): SystemJobContext {
  return { kind: "system-job", organizationId, jobName: "scoped-client-test" };
}

beforeAll(async () => {
  await prisma.organization.createMany({
    data: [
      { id: ORG_A, slug: ORG_A, name: "Scoped Client Test Org A", status: "ACTIVE" },
      { id: ORG_B, slug: ORG_B, name: "Scoped Client Test Org B", status: "ACTIVE" },
    ],
    skipDuplicates: true,
  });
  await prisma.academy.createMany({
    data: [
      {
        id: ACADEMY_B,
        organizationId: ORG_B,
        name: "Scoped Client Test Academy B",
        slug: ACADEMY_B,
        kioskTokenHash: "scoped-client-test-academy-b-kiosk-token-hash",
      },
    ],
    skipDuplicates: true,
  });
  // One BeltRank per org (order 0 within its own org+track) — used across
  // read/write/aggregate/groupBy/upsert coverage below. MULTI_ACADEMY_AND_KIDS_BELTS.md
  // Phase 2 replaced BeltRequirement with this org-owned model, the same
  // representative tenant-scoped model this file has always used to
  // exercise every getScopedDb operation type.
  await prisma.beltRank.createMany({
    data: [
      { id: "scoped-client-test-rank-a", organizationId: ORG_A, track: "ADULT", code: "WHITE", labelEs: "Blanco", labelEn: "White", primaryColor: "#F0EBE0", barColor: "#111116", order: 0, attendancesPerStripe: 10, maxStripes: 4, attendancesForExam: 40, stripeColors: [] },
      { id: "scoped-client-test-rank-b", organizationId: ORG_B, track: "ADULT", code: "WHITE", labelEs: "Blanco", labelEn: "White", primaryColor: "#F0EBE0", barColor: "#111116", order: 0, attendancesPerStripe: 20, maxStripes: 4, attendancesForExam: 80, stripeColors: [] },
    ],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  await prisma.classSession.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.beltRank.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
});

describe("reads: findUnique / findUniqueOrThrow / findFirst / findFirstOrThrow / findMany", () => {
  it("findUnique returns null for a row that exists but belongs to another organization", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const result = await dbA.beltRank.findUnique({ where: { id: "scoped-client-test-rank-b" } });
    expect(result).toBeNull();
  });

  it("findUniqueOrThrow throws (not leaks) for a row belonging to another organization", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect(dbA.beltRank.findUniqueOrThrow({ where: { id: "scoped-client-test-rank-b" } })).rejects.toThrow();
  });

  it("findFirst / findFirstOrThrow only ever see the caller's own organization's row", async () => {
    const dbB = getScopedDb(ctxFor(ORG_B));
    const first = await dbB.beltRank.findFirst({ where: { code: "WHITE" } });
    expect(first?.id).toBe("scoped-client-test-rank-b");
    const firstOrThrow = await dbB.beltRank.findFirstOrThrow({ where: { code: "WHITE" } });
    expect(firstOrThrow.id).toBe("scoped-client-test-rank-b");
  });

  it("findMany never returns another organization's rows, even with a wide-open where", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const rows = await dbA.beltRank.findMany({ where: { code: "WHITE" } });
    expect(rows.map((r) => r.id)).toEqual(["scoped-client-test-rank-a"]);
  });

  it("caller-supplied organizationId in `where` cannot override the wrapper's own — the wrapper's literal always wins", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    // Attempt to read org B's row while impersonating org A's context by
    // supplying organizationId: ORG_B directly in the caller's own `where`.
    const result = await dbA.beltRank.findFirst({
      where: { id: "scoped-client-test-rank-b", organizationId: ORG_B } as never,
    });
    expect(result).toBeNull();
  });
});

describe("aggregates and groupBy", () => {
  it("aggregate only sums the caller's own organization's rows", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const agg = await dbA.beltRank.aggregate({ _sum: { attendancesForExam: true } });
    expect(agg._sum.attendancesForExam).toBe(40); // org A's row only (40), not 40+80
  });

  it("groupBy only groups the caller's own organization's rows", async () => {
    const dbB = getScopedDb(ctxFor(ORG_B));
    const groups = await dbB.beltRank.groupBy({ by: ["code"], _count: true });
    expect(groups).toEqual([{ code: "WHITE", _count: 1 }]);
  });

  it("count only counts the caller's own organization's rows", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    expect(await dbA.beltRank.count({ where: { code: "WHITE" } })).toBe(1);
  });
});

describe("create / update / delete and bulk variants", () => {
  it("create forces organizationId to the context's own, ignoring any caller-supplied value", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const created = await dbA.beltRank.create({
      data: { id: "scoped-client-test-rank-a-create", organizationId: ORG_B as never, track: "ADULT", code: "BLUE", labelEs: "Azul", labelEn: "Blue", primaryColor: "#215DA5", barColor: "#111116", order: 1, attendancesPerStripe: 1, maxStripes: 1, attendancesForExam: 1, stripeColors: [] },
    });
    expect(created.organizationId).toBe(ORG_A);
    await dbA.beltRank.delete({ where: { id: "scoped-client-test-rank-a-create" } });
  });

  it("update/delete on a real id belonging to ANOTHER organization affects nothing (P2025, not a cross-tenant write)", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect(
      dbA.beltRank.update({ where: { id: "scoped-client-test-rank-b" }, data: { maxStripes: 99 } }),
    ).rejects.toThrow();
    await expect(dbA.beltRank.delete({ where: { id: "scoped-client-test-rank-b" } })).rejects.toThrow();
    // Org B's row is untouched.
    const stillThere = await prisma.beltRank.findUniqueOrThrow({ where: { id: "scoped-client-test-rank-b" } });
    expect(stillThere.maxStripes).toBe(4);
  });

  it("createMany forces organizationId on every row, including array form", async () => {
    const dbB = getScopedDb(ctxFor(ORG_B));
    await dbB.beltRank.createMany({
      data: [
        { id: "scoped-client-test-rank-b-blue", organizationId: ORG_A as never, track: "ADULT", code: "BLUE", labelEs: "Azul", labelEn: "Blue", primaryColor: "#215DA5", barColor: "#111116", order: 1, attendancesPerStripe: 1, maxStripes: 1, attendancesForExam: 1, stripeColors: [] },
        { id: "scoped-client-test-rank-b-purple", organizationId: ORG_A as never, track: "ADULT", code: "PURPLE", labelEs: "Morado", labelEn: "Purple", primaryColor: "#652F94", barColor: "#111116", order: 2, attendancesPerStripe: 1, maxStripes: 1, attendancesForExam: 1, stripeColors: [] },
      ],
    });
    const rows = await prisma.beltRank.findMany({ where: { id: { in: ["scoped-client-test-rank-b-blue", "scoped-client-test-rank-b-purple"] } } });
    expect(rows.every((r) => r.organizationId === ORG_B)).toBe(true);
    await dbB.beltRank.deleteMany({ where: { id: { in: ["scoped-client-test-rank-b-blue", "scoped-client-test-rank-b-purple"] } } });
  });

  it("updateMany/deleteMany never touch another organization's rows", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const affected = await dbA.beltRank.updateMany({ where: {}, data: { maxStripes: 7 } });
    expect(affected.count).toBe(1); // org A has exactly 1 BeltRank row
    const orgBRow = await prisma.beltRank.findUniqueOrThrow({ where: { id: "scoped-client-test-rank-b" } });
    expect(orgBRow.maxStripes).toBe(4); // untouched
    await prisma.beltRank.update({ where: { id: "scoped-client-test-rank-a" }, data: { maxStripes: 4 } }); // restore
  });
});

describe("upsert", () => {
  it("upsert's create/update legs both stay pinned to the context's organization", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    // Insert leg: no existing row with this id, so it creates — forced to ORG_A.
    const inserted = await dbA.beltRank.upsert({
      where: { id: "scoped-client-test-rank-upsert" },
      create: { id: "scoped-client-test-rank-upsert", organizationId: ORG_B as never, track: "ADULT", code: "BROWN", labelEs: "Café", labelEn: "Brown", primaryColor: "#643D20", barColor: "#111116", order: 1, attendancesPerStripe: 1, maxStripes: 1, attendancesForExam: 1, stripeColors: [] },
      update: { maxStripes: 2 },
    });
    expect(inserted.organizationId).toBe(ORG_A);

    // Update leg, run again with a DIFFERENT context (org B) — the `where`
    // is pinned to org B, so it can't see org A's row and creates its own
    // instead of mutating org A's.
    const dbB = getScopedDb(ctxFor(ORG_B));
    const separateRow = await dbB.beltRank.upsert({
      where: { id: "scoped-client-test-rank-upsert" },
      create: { id: "scoped-client-test-rank-upsert-b", organizationId: ORG_A as never, track: "ADULT", code: "BROWN", labelEs: "Café", labelEn: "Brown", primaryColor: "#643D20", barColor: "#111116", order: 1, attendancesPerStripe: 1, maxStripes: 1, attendancesForExam: 1, stripeColors: [] },
      update: { maxStripes: 2 },
    });
    expect(separateRow.organizationId).toBe(ORG_B);

    const orgARowUnchanged = await prisma.beltRank.findUniqueOrThrow({ where: { id: "scoped-client-test-rank-upsert" } });
    expect(orgARowUnchanged.maxStripes).toBe(1); // org B's upsert never touched it

    await prisma.beltRank.deleteMany({ where: { id: { in: ["scoped-client-test-rank-upsert", "scoped-client-test-rank-upsert-b"] } } });
  });
});

describe("nested writes and relation `connect`", () => {
  it("a nested `connect` to another organization's row is rejected by the composite foreign key (P2003), not silently allowed", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect(
      dbA.classSession.create({
        data: {
          id: "scoped-client-test-cross-org-connect",
          dayOfWeek: "MONDAY",
          startTime: "06:00",
          durationMinutes: 60,
          name: "Scoped Client Cross-Org Connect Attempt",
          type: "GI",
          // organizationId forced to ORG_A by the wrapper, but this connects
          // to Academy B — which belongs to ORG_B. No (ORG_A, academyB.id)
          // row exists, so the composite FK rejects the insert outright.
          academy: { connect: { id: ACADEMY_B } },
        } as never,
      }),
    ).rejects.toThrow();
  });

  it("a nested `connect` within the SAME organization succeeds", async () => {
    const dbB = getScopedDb(ctxFor(ORG_B));
    const created = await dbB.classSession.create({
      data: {
        id: "scoped-client-test-same-org-connect",
        dayOfWeek: "TUESDAY",
        startTime: "07:00",
        durationMinutes: 60,
        name: "Scoped Client Same-Org Connect",
        type: "GI",
        academy: { connect: { id: ACADEMY_B } },
      } as never,
    });
    expect(created.organizationId).toBe(ORG_B);
    expect(created.academyId).toBe(ACADEMY_B);
  });
});

describe("transactions", () => {
  it("batch $transaction still enforces org scope on every operation in the batch", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    const [, updated] = await dbA.$transaction([
      dbA.beltRank.findMany({ where: {} }),
      dbA.beltRank.update({ where: { id: "scoped-client-test-rank-a" }, data: { maxStripes: 5 } }),
    ]);
    expect(updated.organizationId).toBe(ORG_A);
    await prisma.beltRank.update({ where: { id: "scoped-client-test-rank-a" }, data: { maxStripes: 4 } }); // restore
  });

  it("interactive $transaction callback's `tx` client is still org-scoped", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect(
      dbA.$transaction(async (tx) => {
        // Same rejection as the top-level cross-tenant update test — proves
        // the interactive callback's client didn't lose its scoping.
        await tx.beltRank.update({ where: { id: "scoped-client-test-rank-b" }, data: { maxStripes: 1 } });
      }),
    ).rejects.toThrow();
    const stillThere = await prisma.beltRank.findUniqueOrThrow({ where: { id: "scoped-client-test-rank-b" } });
    expect(stillThere.maxStripes).toBe(4);
  });
});

describe("raw SQL and non-tenant models", () => {
  it("$queryRaw is confined to the platform module — refused, not silently unscoped", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect((dbA as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw()).rejects.toThrow(
      CrossTenantAccessError,
    );
  });

  it("$executeRawUnsafe is confined to the platform module", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    await expect(
      (dbA as unknown as { $executeRawUnsafe: (sql: string) => Promise<unknown> }).$executeRawUnsafe("SELECT 1"),
    ).rejects.toThrow(CrossTenantAccessError);
  });

  it("a platform-only model (Organization) is refused via the tenant-scoped client, even bypassing ScopedDb's type", async () => {
    const dbA = getScopedDb(ctxFor(ORG_A)) as unknown as { organization: { findMany: () => Promise<unknown> } };
    await expect(dbA.organization.findMany()).rejects.toThrow(CrossTenantAccessError);
  });

  it("`ScopedDb`'s type surface has no raw-SQL or platform-model delegates — compile-time, not just runtime", () => {
    const dbA = getScopedDb(ctxFor(ORG_A));
    // @ts-expect-error — organization is not part of ScopedDb's type
    void dbA.organization;
    // @ts-expect-error — $queryRaw is not part of ScopedDb's type
    void dbA.$queryRaw;
  });
});

describe("cross-organization real-world proof (Alliance vs. a scratch org)", () => {
  it("a context scoped to the scratch org cannot see, or connect to, the real seeded Alliance academy", async () => {
    const dbB = getScopedDb(ctxFor(ORG_B));
    await expect(
      dbB.classSession.create({
        data: {
          id: "scoped-client-test-reach-into-alliance",
          dayOfWeek: "WEDNESDAY",
          startTime: "08:00",
          durationMinutes: 60,
          name: "Scoped Client Reach Into Alliance",
          type: "GI",
          academy: { connect: { id: ESCAZU_ID } },
        } as never,
      }),
    ).rejects.toThrow();
    // Alliance's own academy is never readable through org B's context.
    const leak = await dbB.academy.findUnique({ where: { id: ESCAZU_ID } });
    expect(leak).toBeNull();
  });
});
