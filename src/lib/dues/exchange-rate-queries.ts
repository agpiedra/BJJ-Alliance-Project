import { prisma } from "@/lib/prisma";

/**
 * Owner exchange-rate UI, read side. Plain module, no "use server" directive — these are composition cores a
 * "use server" action wraps after its own auth check, never independently client-invocable themselves. Mirrors
 * `src/lib/dues/ledger/exchange-rate.ts`'s own fixed `PROVIDER`/`PAIR`/`SIDE` constants (not exported there, so
 * duplicated here rather than widening that file's export surface for a display-only read) — there is exactly one
 * rate to read, same as there is exactly one to write.
 */

const PROVIDER = "BCR";
const PAIR = "USD/CRC";
const SIDE = "SELL";

export interface ExchangeRateQuoteRow {
  id: string;
  quoteDate: { year: number; month: number; day: number };
  revision: number;
  value: string;
}

function fromUtcDate(date: Date): ExchangeRateQuoteRow["quoteDate"] {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function toUtcDate(date: ExchangeRateQuoteRow["quoteDate"]): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/**
 * How many `DuesPayment` rows reference the EXACT quote row `quoteId` — a live, uncached aggregate, not a stored or
 * cached value (see this feature's planning brief §2.2 for why it is never treated as inherently frozen). Never
 * trusts a bare id: scoped to `organizationId` first, so a wrong-organization or nonexistent id reports 0 rather
 * than leaking another organization's count or throwing.
 */
export async function countPaymentsAgainstQuote(organizationId: string, quoteId: string): Promise<number> {
  const quote = await prisma.exchangeRateQuote.findFirst({ where: { id: quoteId, organizationId }, select: { id: true } });
  if (!quote) return 0;
  return prisma.duesPayment.count({ where: { organizationId, appliedRateId: quoteId } });
}

/**
 * The current (highest-revision) row for one exact `quoteDate`, or null if none exists yet. Display only — the
 * stale-form refresh banner's source of "what changed" — never consulted by `enterExchangeRateQuote`'s own
 * `expectedCurrentRevision` check, which remains the sole authority over whether a write succeeds.
 */
export async function findCurrentExchangeRateQuote(organizationId: string, quoteDate: ExchangeRateQuoteRow["quoteDate"]): Promise<ExchangeRateQuoteRow | null> {
  const row = await prisma.exchangeRateQuote.findFirst({
    where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: toUtcDate(quoteDate) },
    orderBy: { revision: "desc" },
    select: { id: true, quoteDate: true, revision: true, value: true },
  });
  return row ? { id: row.id, quoteDate: fromUtcDate(row.quoteDate), revision: row.revision, value: row.value.toString() } : null;
}

/**
 * The most recently entered dates, each at its own current (highest) revision — a plain, unlocked list for display.
 * Deliberately NOT `resolveEffectiveQuote` (exchange-rate.ts): that function requires the caller to already hold
 * `lockExchangeRateNamespaceShared` inside an open transaction (its own doc comment, lines 223-241) and resolves
 * "effective for a received date," a settlement-time concept this admin list has no use for — every row here is
 * keyed to its own explicit entered date, not a receivedOn fallback (see this feature's planning brief §2.5).
 */
export async function listRecentExchangeRateQuotes(organizationId: string, limit = 20): Promise<ExchangeRateQuoteRow[]> {
  const rows = await prisma.exchangeRateQuote.findMany({
    where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE },
    orderBy: [{ quoteDate: "desc" }, { revision: "desc" }],
    select: { id: true, quoteDate: true, revision: true, value: true },
  });
  const seenDates = new Set<number>();
  const current: ExchangeRateQuoteRow[] = [];
  for (const row of rows) {
    const key = row.quoteDate.getTime();
    if (seenDates.has(key)) continue; // a lower revision for an already-seen date — not the current one
    seenDates.add(key);
    current.push({ id: row.id, quoteDate: fromUtcDate(row.quoteDate), revision: row.revision, value: row.value.toString() });
    if (current.length >= limit) break;
  }
  return current;
}
