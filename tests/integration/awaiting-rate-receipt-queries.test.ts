import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { listAwaitingRateReceipts, findReceiptStatus } from "../../src/lib/dues/awaiting-rate-receipt-queries";

/**
 * Owner awaiting-rate receipt queue brief §5.1 (reader tier): `listAwaitingRateReceipts`/`findReceiptStatus` called
 * DIRECTLY against the real test database. This feature's own brief correction #1: real cursor pagination (never a
 * single bounded fetch) must actually reach rows beyond the first page, with a deterministic `id` tie-break so
 * same-`capturedAt` rows are never skipped or repeated. Correction #2: a malformed or kind-mismatched snapshot must
 * produce an explicit `snapshotIntegrityFailure`, never a silently empty proposal or a thrown error.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let a: Fixture;
let b: Fixture;
let studentA: { id: string };

async function newStudent(fixture: Fixture, label: string) {
  return prisma.student.create({
    data: {
      organizationId: fixture.org.id, homeAcademyId: fixture.academy.id, firstName: "Receipt", lastName: `${label}-${suffix}`, phone: "00000000",
      email: `receipt-${label}-${suffix}@example.com`, currentRankId: await fixture.rankId("WHITE"), codeHash: `receipt-${label}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function createReceipt(
  fixture: Fixture,
  studentId: string,
  overrides: { status?: "PENDING" | "RESOLVED" | "CANCELLED"; capturedAt?: Date; kind?: "ORDINARY" | "PREPAYMENT" | "PACKAGE"; snapshot?: unknown } = {},
) {
  const kind = overrides.kind ?? "ORDINARY";
  const snapshot = overrides.snapshot ?? { kind, obligationIds: ["ob-1"] };
  const status = overrides.status ?? "PENDING";
  return prisma.awaitingRateReceipt.create({
    data: {
      organizationId: fixture.org.id, studentId, academyId: fixture.academy.id, kind, status,
      receivedOn: new Date("2030-01-01"), tenderCurrency: "CRC", tenderAmount: "100.00", method: "EFECTIVO",
      capturedAt: overrides.capturedAt ?? new Date(), capturedById: fixture.admin.id, snapshot: snapshot as object,
      // AwaitingRateReceipt_status_markers_consistent: a RESOLVED/CANCELLED row must carry its own marker fields.
      ...(status === "RESOLVED" ? { resolvedAt: new Date(), resolvedById: fixture.admin.id } : {}),
      ...(status === "CANCELLED" ? { cancelledAt: new Date(), cancelledById: fixture.admin.id, cancellationReason: "test fixture" } : {}),
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "receiptq-a");
  b = await makeAccountingOrg("CUMULATIVE", "receiptq-b");
  studentA = await newStudent(a, "main");
}, 60_000);

afterAll(async () => {
  // AwaitingRateReceipt rows are never deleted by the application (a DB trigger enforces it, matching the engine's
  // own doc comment) — `session_replication_role = replica` bypasses that trigger for test cleanup only, the same
  // technique `awaiting-rate-receipt.test.ts`'s own afterAll already uses.
  for (const fixture of [a, b]) {
    if (!fixture) continue;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRawUnsafe(`DELETE FROM "AwaitingRateReceipt" WHERE "organizationId" = $1`, fixture.org.id);
      },
      { timeout: 60_000 },
    );
  }
  await a?.drop();
  await b?.drop();
}, 60_000);

describe("listAwaitingRateReceipts: real cursor pagination, never fetch-all-then-slice", () => {
  it("pages through more than one page's worth of PENDING receipts, seeing every row exactly once, even among same-capturedAt rows (id tie-break)", async () => {
    const sharedInstant = new Date("2031-06-01T12:00:00.000Z");
    const created = [];
    for (let i = 0; i < 30; i++) {
      // Every third row shares the EXACT same capturedAt instant — without the `id` tie-break in orderBy, cursor
      // pagination over these would be undefined (a row could be skipped or repeated across pages).
      const capturedAt = i % 3 === 0 ? sharedInstant : new Date(sharedInstant.getTime() - i * 1000);
      created.push(await createReceipt(a, studentA.id, { capturedAt }));
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listAwaitingRateReceipts(a.org.id, { status: "PENDING", limit: 7, cursor });
      pages++;
      for (const row of page.rows) {
        expect(seen.has(row.id), `row ${row.id} seen twice across pages`).toBe(false);
        seen.add(row.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages, "pagination never terminates").toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1); // genuinely paged, not a single bounded fetch
    for (const row of created) expect(seen.has(row.id)).toBe(true);
  });

  it("status filtering: PENDING/RESOLVED/CANCELLED each return only their own rows", async () => {
    const pending = await createReceipt(a, studentA.id, { status: "PENDING" });
    const resolved = await createReceipt(a, studentA.id, { status: "RESOLVED" });
    const cancelled = await createReceipt(a, studentA.id, { status: "CANCELLED" });

    const pendingPage = await listAwaitingRateReceipts(a.org.id, { status: "PENDING", limit: 100 });
    const resolvedPage = await listAwaitingRateReceipts(a.org.id, { status: "RESOLVED", limit: 100 });
    const cancelledPage = await listAwaitingRateReceipts(a.org.id, { status: "CANCELLED", limit: 100 });

    expect(pendingPage.rows.some((r) => r.id === pending.id)).toBe(true);
    expect(pendingPage.rows.some((r) => r.id === resolved.id || r.id === cancelled.id)).toBe(false);
    expect(resolvedPage.rows.some((r) => r.id === resolved.id)).toBe(true);
    expect(cancelledPage.rows.some((r) => r.id === cancelled.id)).toBe(true);
  });

  it("organization isolation: org A never sees org B's receipts", async () => {
    const studentB = await newStudent(b, "isolation");
    const bReceipt = await createReceipt(b, studentB.id);
    const page = await listAwaitingRateReceipts(a.org.id, { limit: 200 });
    expect(page.rows.some((r) => r.id === bReceipt.id)).toBe(false);
  });

  it("refuses safely (empty result) on malformed input, never throwing", async () => {
    expect(await listAwaitingRateReceipts("", {})).toEqual({ rows: [], nextCursor: null });
    expect(await listAwaitingRateReceipts(undefined as unknown as string, {})).toEqual({ rows: [], nextCursor: null });
    const badStatus = await listAwaitingRateReceipts(a.org.id, { status: "BOGUS" as never });
    expect(badStatus.rows.length).toBeGreaterThanOrEqual(0); // an invalid status is ignored (no filter), never throws
    const badCursor = await listAwaitingRateReceipts(a.org.id, { cursor: "" });
    expect(badCursor).toBeTruthy();
    const badLimit = await listAwaitingRateReceipts(a.org.id, { limit: -5 });
    expect(badLimit.rows.length).toBeLessThanOrEqual(25); // clamped to the default, never a negative/zero take
  });

  it("a cursor naming a nonexistent id returns an empty page, never a thrown P2025", async () => {
    const result = await listAwaitingRateReceipts(a.org.id, { cursor: "nonexistent-receipt-id" });
    expect(result).toEqual({ rows: [], nextCursor: null });
  });

  it("a cursor naming another organization's real id returns an empty page, not that organization's data", async () => {
    const studentB = await newStudent(b, "crosscursor");
    const bReceipt = await createReceipt(b, studentB.id);
    const result = await listAwaitingRateReceipts(a.org.id, { cursor: bReceipt.id });
    expect(result).toEqual({ rows: [], nextCursor: null });
  });

  it("a genuinely malformed snapshot produces snapshotIntegrityFailure, never a silently empty proposal or a thrown error — the row still renders", async () => {
    const receipt = await createReceipt(a, studentA.id, { snapshot: { kind: "ORDINARY" /* missing required obligationIds */ } });
    const page = await listAwaitingRateReceipts(a.org.id, { limit: 200 });
    const row = page.rows.find((r) => r.id === receipt.id);
    expect(row).toBeTruthy();
    expect(row!.proposal).toEqual({ ok: false, reason: "snapshotIntegrityFailure" });
  });

  it("a well-formed snapshot whose own kind disagrees with the row's real kind column is also snapshotIntegrityFailure", async () => {
    const receipt = await createReceipt(a, studentA.id, {
      kind: "ORDINARY",
      snapshot: { kind: "PACKAGE", planTermsId: "t1", priceAmount: "100.00", startMonth: { year: 2031, month: 1 }, coverageMonths: [{ year: 2031, month: 1 }], existingObligationIds: [] },
    });
    const page = await listAwaitingRateReceipts(a.org.id, { limit: 200 });
    const row = page.rows.find((r) => r.id === receipt.id);
    expect(row!.proposal).toEqual({ ok: false, reason: "snapshotIntegrityFailure" });
  });

  it("PACKAGE coverage is read directly from snapshot.coverageMonths, never derived from a monthsCovered field (which the snapshot does not have)", async () => {
    const receipt = await createReceipt(a, studentA.id, {
      kind: "PACKAGE",
      snapshot: {
        kind: "PACKAGE", planTermsId: "t1", priceAmount: "100.00",
        startMonth: { year: 2031, month: 3 },
        coverageMonths: [{ year: 2031, month: 3 }, { year: 2031, month: 4 }, { year: 2031, month: 5 }],
        existingObligationIds: [],
      },
    });
    const page = await listAwaitingRateReceipts(a.org.id, { limit: 200 });
    const row = page.rows.find((r) => r.id === receipt.id)!;
    expect(row.proposal).toEqual({ ok: true, existingObligationIds: [], proposedCoverage: [{ year: 2031, month: 3 }, { year: 2031, month: 4 }, { year: 2031, month: 5 }] });
  });
});

describe("findReceiptStatus", () => {
  it("returns the real status, scoped by organizationId and id", async () => {
    const receipt = await createReceipt(a, studentA.id, { status: "RESOLVED" });
    expect(await findReceiptStatus(a.org.id, receipt.id)).toEqual({ status: "RESOLVED" });
  });

  it("returns null for a wrong-organization id, a nonexistent id, or malformed input", async () => {
    const studentB = await newStudent(b, "statuscross");
    const bReceipt = await createReceipt(b, studentB.id);
    expect(await findReceiptStatus(a.org.id, bReceipt.id)).toBeNull();
    expect(await findReceiptStatus(a.org.id, "nonexistent")).toBeNull();
    expect(await findReceiptStatus("", "whatever")).toBeNull();
  });
});
