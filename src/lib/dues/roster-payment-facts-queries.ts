import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { listDuesFactsForStudents, type DuesFactsForStudent, type DuesPendingReceiptFact } from "@/lib/dues/ledger/dues-facts";
import { todayIn } from "@/lib/dues/ledger/common";
import type { Currency } from "@/generated/prisma/client";

// Type-only re-export (erased at compile time — unlike a value import, this does NOT pull this module's own
// `prisma` import into a consumer, which matters for component unit tests that never connect to a real database).
export type { DuesPendingReceiptFact };

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.2/§2.4: a plain, never-"use server" read wrapper over
 * `listDuesFactsForStudents` — the roster/student-detail pages' own ONLY ledger import, so neither page needs to
 * import `dues/ledger` directly (matches `[id]/page.tsx`'s own existing "never import the ledger directly" convention
 * for its `latestEffective` duplication). Registered in `tests/unit/dues-ledger-not-exposed.test.ts`'s
 * `AUTHORIZED_CALLERS` because it imports `dues-facts.ts`/`ledger/common.ts` directly.
 */

const MAX_SELECTED = 60;
/** Chunks in flight at once — bounded, never one `Promise.all` over every chunk (brief §2.2's own correction). */
const CHUNK_CONCURRENCY = 4;

/** Page-level pre-check so neither page imports `ledger/activation` directly. Read ONCE per page load. */
export async function isLedgerActiveForOrg(organizationId: string, deps: LedgerDeps = {}): Promise<boolean> {
  const activation = deps.activation ?? inactiveLedgerActivation;
  return activation.isActive(organizationId);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** A small, fixed-concurrency runner — no new dependency (brief §2.2: "a plain loop/semaphore shape is sufficient").
 * `limit` workers pull the next index as soon as they finish; never more than `limit` calls to `worker` are
 * in flight simultaneously. */
async function runBounded<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export type RosterPaymentFact =
  | { ok: true; facts: DuesFactsForStudent; todayIso: string }
  | { ok: false };

/**
 * Batched roster facts (brief §2.2): chunks `studentIds` into groups of ≤`MAX_SELECTED`, runs chunks with a fixed
 * concurrency limit, and passes the SAME captured `now` to every chunk's `listDuesFactsForStudents` call — two
 * students in different branches, possibly landing in different chunks, are always evaluated against the identical
 * moment. A chunk that fails (or a student missing from an otherwise-successful chunk) is reported `{ok:false}` for
 * exactly those ids — NEVER silently coerced into "no debt"/"paid". Also resolves each student's own branch-local
 * "today" (ISO date, `todayIn`) for callers that need it (e.g. an unpaid SIGNUP past its own `dueOn`) — the SAME
 * timezone resolution `dues-facts.ts` uses internally, never a second, drifting re-derivation.
 */
export async function listRosterPaymentFacts(
  context: TenantContext,
  studentIds: readonly string[],
  now: Date,
  deps: LedgerDeps = {},
): Promise<{ byStudentId: Map<string, RosterPaymentFact>; chunkCallCount: number }> {
  const byStudentId = new Map<string, RosterPaymentFact>();
  if (studentIds.length === 0) return { byStudentId, chunkCallCount: 0 };

  const chunks = chunk(studentIds, MAX_SELECTED);
  const chunkDeps: LedgerDeps = { ...deps, now: () => now };

  await runBounded(chunks, CHUNK_CONCURRENCY, async (ids) => {
    let timezoneById: Map<string, string>;
    try {
      const rows = await prisma.student.findMany({
        where: { id: { in: [...ids] }, organizationId: context.organizationId },
        select: { id: true, homeAcademy: { select: { timezone: true } } },
      });
      timezoneById = new Map(rows.map((r) => [r.id, r.homeAcademy.timezone]));
    } catch {
      for (const id of ids) byStudentId.set(id, { ok: false });
      return;
    }

    let result;
    try {
      result = await listDuesFactsForStudents(context, [...ids], undefined, chunkDeps);
    } catch {
      for (const id of ids) byStudentId.set(id, { ok: false });
      return;
    }
    if (!result.ok) {
      for (const id of ids) byStudentId.set(id, { ok: false });
      return;
    }

    const factsById = new Map(result.facts.map((f) => [f.studentId, f]));
    for (const id of ids) {
      const facts = factsById.get(id);
      const timezone = timezoneById.get(id);
      if (!facts || !timezone) {
        byStudentId.set(id, { ok: false });
        continue;
      }
      const today = todayIn(timezone, now);
      const todayIso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
      byStudentId.set(id, { ok: true, facts, todayIso });
    }
  });

  return { byStudentId, chunkCallCount: chunks.length };
}

export type CurrencyTotal = { currency: Currency; amountMinor: number; feeMinor: number | null };

export type RosterLedgerFlags = {
  debt: boolean;
  noDebt: boolean;
  monthlyPastGrace: boolean;
  signupPastDue: boolean;
  pendingConversion: boolean;
  configIssue: boolean;
};

export type RosterLedgerDisplay = { totals: CurrencyTotal[]; flags: RosterLedgerFlags };

export type RosterLedgerEntry = { kind: "ledger"; display: RosterLedgerDisplay } | { kind: "unavailable" };

/**
 * The approved OR semantics (brief §3 decision 5: "independently-true, overlapping flags"): any ONE checked filter
 * matching is enough to include a student — never AND. An `unavailable` entry (a failed read) is always shown
 * regardless of which filters are active; its own unavailability is itself the visible state, never silently
 * counted as matching OR excluded. Extracted as a plain, exported, DB-free function so this exact matching rule —
 * including the signupPastDue/pendingConversion/configIssue flags, previously only exercised indirectly — is
 * directly unit-testable without a page render or a database.
 */
export function matchesActiveLedgerFilters(entry: RosterLedgerEntry, activeFilters: ReadonlySet<keyof RosterLedgerFlags>): boolean {
  if (entry.kind === "unavailable") return true;
  if (activeFilters.size === 0) return true;
  return [...activeFilters].some((key) => entry.display.flags[key]);
}

/**
 * Brief §3 decision 1/5: per-currency unsettled totals (fee already folded into `outstandingAmountMinor` by
 * `dues-facts.ts` itself — never added again here) plus the five approved independent filter flags. `todayIso` must
 * be the SAME branch-local "today" `listRosterPaymentFacts` resolved for this student (see above) — an unpaid
 * SIGNUP past its own `dueOn` is a NEW condition, distinct from `pastGrace` (which is always `null` for SIGNUP).
 */
export function toRosterLedgerDisplay(facts: DuesFactsForStudent, todayIso: string): RosterLedgerDisplay {
  const unsettled = facts.outstanding.filter((o) => !o.settled);
  const byCurrency = new Map<Currency, CurrencyTotal>();
  for (const o of unsettled) {
    const entry = byCurrency.get(o.currency) ?? { currency: o.currency, amountMinor: 0, feeMinor: null };
    entry.amountMinor += o.outstandingAmountMinor;
    if (o.outstandingFeeMinor) entry.feeMinor = (entry.feeMinor ?? 0) + o.outstandingFeeMinor;
    byCurrency.set(o.currency, entry);
  }

  const hasDebt = unsettled.length > 0;
  const monthlyPastGrace = unsettled.some((o) => o.type === "MONTHLY" && o.pastGrace === true);
  const signupPastDue = unsettled.some((o) => o.type === "SIGNUP" && o.dueOn !== null && o.dueOn < todayIso);
  const pendingConversion = facts.pendingReceipts.length > 0;
  const configIssue = facts.eligibility.outcome === "MISSING_CONFIGURATION" || facts.eligibility.outcome === "OBSERVED_DISCREPANCY";

  return {
    totals: [...byCurrency.values()],
    flags: { debt: hasDebt, noDebt: !hasDebt, monthlyPastGrace, signupPastDue, pendingConversion, configIssue },
  };
}
