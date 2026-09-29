import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { enterExchangeRateQuote, resolveEffectiveQuote } from "../../src/lib/dues/ledger/exchange-rate";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { prisma as appPrisma } from "../../src/lib/prisma";

/**
 * Currency-conversion brief, PR 1: `enterExchangeRateQuote`/`resolveEffectiveQuote` proved against the REAL test
 * database — revision allocation, fallback resolution, tenant/owner isolation, and the genuine two-connection
 * concurrency proof, following the exact fixture/concurrency conventions `waive-late-fee.test.ts` established.
 * Pure rounding/arithmetic is already covered by `tests/unit/dues-exchange-rate-arithmetic.test.ts`.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let b: Fixture;
let c: Fixture; // dedicated, kept empty until its own describe block — resolveEffectiveQuote's null-fallback tests need
// an organization no other test has ever entered a quote for. "No automatic rate-age cutoff" (approved policy) means any
// earlier quote in `a`, however old, is a VALID fallback — so those two tests cannot share `a`'s accumulating quotes.

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let dateCounter = 0;
/** A fresh, never-reused quote date per test, so tests never contend over revision numbers with each other. */
function freshDate(): { year: number; month: number; day: number } {
  const day = 1 + (dateCounter++ % 27);
  const month = 1 + (Math.floor(dateCounter / 27) % 12);
  return { year: 2031, month, day };
}

const enter = (over: Partial<Parameters<typeof enterExchangeRateQuote>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  enterExchangeRateQuote({ context: context(), quoteDate: freshDate(), value: "505.37", expectedCurrentRevision: 0, ...over }, deps(extraDeps));

async function counts(organizationId: string) {
  return {
    quotes: await prisma.exchangeRateQuote.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: "exchangeRateQuote.enter" } }),
  };
}

async function resolve(organizationId: string, receivedOn: { year: number; month: number; day: number }) {
  // resolveEffectiveQuote's `Tx` type is derived from the app's own `@/lib/prisma` singleton (see src/lib/students/lock.ts),
  // not the test-only client `prisma` above (which points at the same test database — see test-db.ts's own comment).
  return appPrisma.$transaction((tx) => resolveEffectiveQuote(tx, { organizationId, receivedOn }));
}

/** Mirrors `waive-late-fee.test.ts`'s `holdStudentLock`, but holds the ADVISORY lock this feature actually serializes on. */
function holdAdvisoryLock(organizationId: string) {
  let started!: (pid: number) => void;
  const startedPromise = new Promise<number>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${organizationId}))`;
      const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS pid`);
      started(pid);
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

/** Identical chain-walk to `waive-late-fee.test.ts`'s own helper — see that file's comment for why a chain walk, not a direct match, is required. */
async function waitUntilNBlockedByHolder(holderPid: number, n: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number; blockedby: number[] }[]>`SELECT pid, pg_blocking_pids(pid) AS blockedby FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
    const chain = new Map(rows.map((r) => [r.pid, r.blockedby]));
    let reachingHolder = 0;
    for (const pid of chain.keys()) {
      let current = pid;
      const seen = new Set<number>();
      while (!seen.has(current)) {
        seen.add(current);
        const blockers = chain.get(current);
        if (!blockers) break;
        if (blockers.includes(holderPid)) {
          reachingHolder++;
          break;
        }
        const nextHop = blockers.find((bl) => chain.has(bl));
        if (nextHop === undefined) break;
        current = nextHop;
      }
    }
    if (reachingHolder >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "exrate-a");
  b = await makeAccountingOrg("CUMULATIVE", "exrate-b");
  c = await makeAccountingOrg("CUMULATIVE", "exrate-c");
}, 60_000);

/** ExchangeRateQuote rows are genuinely undeletable in normal operation (its own no-delete trigger) — cleanup only,
 * mirroring `waive-late-fee.test.ts`'s own `clearLedgerTables`: disable triggers for this transaction alone. */
async function clearExchangeRateQuotes(organizationId: string) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe(`DELETE FROM "ExchangeRateQuote" WHERE "organizationId" = $1`, organizationId);
    },
    { timeout: 60_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId } });
}

afterAll(async () => {
  for (const org of [a, b, c]) {
    if (!org) continue;
    await clearExchangeRateQuotes(org.org.id);
  }
  await a?.drop();
  await b?.drop();
  await c?.drop();
}, 120_000);

describe("enterExchangeRateQuote: first entry and correction", () => {
  it("a first entry succeeds at revision 1, with no supersedesId, and its own audit row", async () => {
    const d = freshDate();
    const before = await counts(a.org.id);
    const result = await enter({ quoteDate: d, expectedCurrentRevision: 0, value: "505.37" });
    expect(result).toMatchObject({ ok: true, revision: 1 });
    if (!result.ok) throw new Error("unreachable");
    const row = await prisma.exchangeRateQuote.findUniqueOrThrow({ where: { id: result.quoteId } });
    expect(row).toMatchObject({ organizationId: a.org.id, provider: "BCR", pair: "USD/CRC", side: "SELL", revision: 1, supersedesId: null, enteredById: a.admin.id });
    expect(Number(row.value)).toBe(505.37);
    expect(await counts(a.org.id)).toEqual({ quotes: before.quotes + 1, audits: before.audits + 1 });
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "exchangeRateQuote.enter", entityId: result.quoteId } })).toBe(1);
  });

  it("a correct expectedCurrentRevision succeeds at the next revision, superseding the prior one", async () => {
    const d = freshDate();
    const first = await enter({ quoteDate: d, expectedCurrentRevision: 0, value: "500.00" });
    if (!first.ok) throw new Error("fixture: first entry failed");
    const second = await enter({ quoteDate: d, expectedCurrentRevision: 1, value: "505.37", sourceNote: "corrected per BCR sheet" });
    expect(second).toMatchObject({ ok: true, revision: 2 });
    if (!second.ok) throw new Error("unreachable");
    const row = await prisma.exchangeRateQuote.findUniqueOrThrow({ where: { id: second.quoteId } });
    expect(row.supersedesId).toBe(first.quoteId);
    expect(row.sourceNote).toBe("corrected per BCR sheet");
  });

  it("a stale expectedCurrentRevision refuses (stale), writing nothing", async () => {
    const d = freshDate();
    const first = await enter({ quoteDate: d, expectedCurrentRevision: 0 });
    expect(first.ok).toBe(true);
    const before = await counts(a.org.id);

    const stale1 = await enter({ quoteDate: d, expectedCurrentRevision: 0 }); // already advanced to 1
    expect(stale1).toEqual({ ok: false, error: "stale" });
    const stale2 = await enter({ quoteDate: d, expectedCurrentRevision: 2 }); // never existed
    expect(stale2).toEqual({ ok: false, error: "stale" });
    expect(await counts(a.org.id)).toEqual(before);
  });
});

describe("enterExchangeRateQuote: malformed inputs refuse invalid, writing nothing", () => {
  const cases: Array<{ label: string; over: Record<string, unknown> }> = [
    { label: "quoteDate month 13", over: { quoteDate: { year: 2031, month: 13, day: 1 } } },
    { label: "quoteDate day 32", over: { quoteDate: { year: 2031, month: 1, day: 32 } } },
    { label: "quoteDate year out of range", over: { quoteDate: { year: 1999, month: 1, day: 1 } } },
    { label: "value zero", over: { value: "0" } },
    { label: "value zero with decimals", over: { value: "0.000000" } },
    { label: "value negative", over: { value: "-1.5" } },
    { label: "value non-numeric", over: { value: "abc" } },
    { label: "value 7 integer digits (over Decimal(12,6))", over: { value: "1000000" } },
    { label: "value 7 decimal digits", over: { value: "1.1234567" } },
    { label: "value exponential notation", over: { value: "5.05e2" } },
    { label: "value non-string", over: { value: 505.37 } },
    { label: "expectedCurrentRevision negative", over: { expectedCurrentRevision: -1 } },
    { label: "expectedCurrentRevision non-integer", over: { expectedCurrentRevision: 1.5 } },
    { label: "sourceNote over 500 chars", over: { sourceNote: "x".repeat(501) } },
    { label: "sourceNote non-string", over: { sourceNote: 42 } },
  ];
  for (const { label, over } of cases) {
    it(`${label}: refuses invalid, never throws, writes nothing`, async () => {
      const before = await counts(a.org.id);
      let result: Awaited<ReturnType<typeof enter>> | undefined;
      let threw: unknown;
      try {
        result = await enter({ quoteDate: freshDate(), ...over } as never);
      } catch (e) {
        threw = e;
      }
      expect(threw, "must return a typed refusal, never throw").toBeUndefined();
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(await counts(a.org.id)).toEqual(before);
    });
  }

  it("value at the exact Decimal(12,6) boundary (6 integer digits, 6 decimal digits) succeeds", async () => {
    const result = await enter({ quoteDate: freshDate(), value: "999999.999999" });
    expect(result.ok).toBe(true);
  });
});

describe("enterExchangeRateQuote: activation and owner-only authorization", () => {
  it("without an active-ledger dependency injected, refuses notActive, writing nothing", async () => {
    const before = await counts(a.org.id);
    const result = await enterExchangeRateQuote({ context: context(), quoteDate: freshDate(), value: "505.37", expectedCurrentRevision: 0 }); // no deps at all
    expect(result).toEqual({ ok: false, error: "notActive" });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("a non-ADMIN (DIRECTOR) context refuses notFound, writing nothing", async () => {
    const before = await counts(a.org.id);
    const result = await enter({ context: context({ organizationRole: "DIRECTOR" }) });
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
  });
});

describe("enterExchangeRateQuote: tenant isolation", () => {
  it("two organizations entering the identical quoteDate track completely independent revisions", async () => {
    const d = freshDate();
    const aResult = await enter({ quoteDate: d, expectedCurrentRevision: 0 });
    const aCorrection = await enter({ quoteDate: d, expectedCurrentRevision: 1 });
    expect(aResult.ok && aCorrection.ok).toBe(true);

    const bContext: TenantContext = { kind: "tenant", actorUserId: b.admin.id, organizationId: b.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
    const bResult = await enterExchangeRateQuote({ context: bContext, quoteDate: d, value: "512.00", expectedCurrentRevision: 0 }, deps());
    expect(bResult).toMatchObject({ ok: true, revision: 1 }); // org b's own first entry, unaffected by org a's revision 2

    const bResolved = await resolve(b.org.id, d);
    expect(bResolved?.revision).toBe(1);
    expect(bResolved?.value).toBe("512");
  });
});

describe("resolveEffectiveQuote: exact-date match, earlier-date fallback, and never a future date", () => {
  it("resolves the exact date's highest revision when multiple revisions exist for it", async () => {
    const d = freshDate();
    await enter({ quoteDate: d, expectedCurrentRevision: 0, value: "500.00" });
    await enter({ quoteDate: d, expectedCurrentRevision: 1, value: "505.37" });
    const resolved = await resolve(a.org.id, d);
    expect(resolved).toMatchObject({ revision: 2, value: "505.37", quoteDate: d });
  });

  it("falls back to the most recent EARLIER date's highest revision when no exact-date quote exists", async () => {
    const earlier = freshDate();
    await enter({ quoteDate: earlier, expectedCurrentRevision: 0, value: "500.00" });
    await enter({ quoteDate: earlier, expectedCurrentRevision: 1, value: "501.00" });
    const laterNoQuote = { ...earlier, day: Math.min(earlier.day + 1, 27) };
    if (laterNoQuote.day === earlier.day) return; // guard against the rare month-rollover edge from freshDate's own cycling
    const resolved = await resolve(a.org.id, laterNoQuote);
    expect(resolved).toMatchObject({ revision: 2, value: "501" });
    // quoteDate preserved distinctly from receivedOn: the returned date is the earlier quote's own date, not the date asked for.
    expect(resolved?.quoteDate).toEqual(earlier);
  });

  // Both use `c`, an organization no other test ever enters a quote for: "no automatic rate-age cutoff" (approved policy)
  // means any earlier quote, however old, is a valid fallback — so these two cannot share `a`'s accumulating quotes.
  it("resolves to null when no quote exists at all for an organization with none", async () => {
    const resolved = await resolve(c.org.id, { year: 2031, month: 6, day: 15 });
    expect(resolved).toBeNull();
  });

  it("never resolves to a future date: only a later quote exists, and no earlier or exact one, so it resolves to null", async () => {
    const cContext: TenantContext = { kind: "tenant", actorUserId: c.admin.id, organizationId: c.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
    const receivedOn = { year: 2031, month: 6, day: 10 };
    const future = { year: 2031, month: 6, day: 20 };
    const result = await enterExchangeRateQuote({ context: cContext, quoteDate: future, value: "505.37", expectedCurrentRevision: 0 }, deps());
    expect(result.ok).toBe(true);
    const resolved = await resolve(c.org.id, receivedOn);
    expect(resolved).toBeNull();
  });
});

/**
 * Genuine overlapping-transaction proof, not sequential — see `waive-late-fee.test.ts`'s own comment on
 * `holdStudentLock`/`waitUntilNBlockedByHolder` for why a bystander holding the actual lock and a `pg_blocking_pids`
 * chain walk are required instead of a scripted sequential await. Here the bystander holds the exact ADVISORY lock
 * (`pg_advisory_xact_lock(1, hashtext(organizationId))`) `lockExchangeRateNamespace` takes, proving both real writers
 * are genuinely queued on it before either is allowed to proceed.
 */
describe("enterExchangeRateQuote: genuine overlapping transactions", () => {
  it("two simultaneous first-entry attempts for the identical logical key: exactly one becomes revision 1, the other refuses stale", async () => {
    const d = freshDate();
    const { startedPromise, release, held } = holdAdvisoryLock(a.org.id);
    const holderPid = await startedPromise;

    let first: ReturnType<typeof enter> | undefined;
    let second: ReturnType<typeof enter> | undefined;
    try {
      let firstDone = false;
      first = enter({ quoteDate: d, expectedCurrentRevision: 0, value: "500.00" }).then((r) => ((firstDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 1), "the first attempt must genuinely block on the bystander's held advisory lock").toBe(true);
      expect(firstDone).toBe(false);

      let secondDone = false;
      second = enter({ quoteDate: d, expectedCurrentRevision: 0, value: "505.37" }).then((r) => ((secondDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 2), "both attempts must be simultaneously blocked on the bystander's held advisory lock").toBe(true);
      expect(secondDone).toBe(false);

      release();
      await held;
      const [r1, r2] = [await first, await second];
      const oks = [r1, r2].filter((r) => r.ok);
      const stales = [r1, r2].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(stales).toHaveLength(1);
      expect(oks[0]).toMatchObject({ ok: true, revision: 1 });
      expect(stales[0]).toEqual({ ok: false, error: "stale" });
      expect(await prisma.exchangeRateQuote.count({ where: { organizationId: a.org.id, quoteDate: new Date(Date.UTC(d.year, d.month - 1, d.day)) } })).toBe(1);
    } finally {
      release(); // idempotent
      await Promise.allSettled(([held, first, second] as (Promise<unknown> | undefined)[]).filter((p) => p !== undefined));
    }
  }, 20_000);

  it("two simultaneous competing corrections of the same revision: exactly one advances to revision 2, the other refuses stale", async () => {
    const d = freshDate();
    const seed = await enter({ quoteDate: d, expectedCurrentRevision: 0, value: "500.00" });
    if (!seed.ok) throw new Error("fixture: seed entry failed");

    const { startedPromise, release, held } = holdAdvisoryLock(a.org.id);
    const holderPid = await startedPromise;

    let first: ReturnType<typeof enter> | undefined;
    let second: ReturnType<typeof enter> | undefined;
    try {
      let firstDone = false;
      first = enter({ quoteDate: d, expectedCurrentRevision: 1, value: "505.37" }).then((r) => ((firstDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 1), "the first correction must genuinely block on the bystander's held advisory lock").toBe(true);
      expect(firstDone).toBe(false);

      let secondDone = false;
      second = enter({ quoteDate: d, expectedCurrentRevision: 1, value: "510.00" }).then((r) => ((secondDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 2), "both corrections must be simultaneously blocked on the bystander's held advisory lock").toBe(true);
      expect(secondDone).toBe(false);

      release();
      await held;
      const [r1, r2] = [await first, await second];
      const oks = [r1, r2].filter((r) => r.ok);
      const stales = [r1, r2].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(stales).toHaveLength(1);
      expect(oks[0]).toMatchObject({ ok: true, revision: 2 });
      expect(stales[0]).toEqual({ ok: false, error: "stale" });
    } finally {
      release(); // idempotent
      await Promise.allSettled(([held, first, second] as (Promise<unknown> | undefined)[]).filter((p) => p !== undefined));
    }
  }, 20_000);
});

describe("enterExchangeRateQuote: rollback proof", () => {
  it("a failure forced right after the quote row and audit row are written still leaves neither committed", async () => {
    const before = await counts(a.org.id);
    await expect(
      enter({ quoteDate: freshDate() }, { afterExchangeRateQuoteWrittenForTest: async () => { throw new Error("forced failure, proving rollback"); } }),
    ).rejects.toThrow("forced failure");
    expect(await counts(a.org.id)).toEqual(before);
  });
});
