import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import type { CalendarDate } from "@/lib/dues/calendar";
import { isRealDate, toDbDate, fromDbDate, type Tx } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";

export { convertUsdToCrcMinor, convertCrcToUsdMinor, detectAmbiguousRoundedTotals } from "@/lib/dues/ledger/exchange-rate-arithmetic";
export type { SelectableTotal } from "@/lib/dues/ledger/exchange-rate-arithmetic";

/**
 * Currency-conversion brief, PR 1: rate storage and pure arithmetic. Only `BCR`/`"USD/CRC"`/`SELL` exist as values today
 * (`ExchangeRateProvider`/`ExchangeRateSide` each have exactly one member, `pair` is DB-CHECKed to one string) — this
 * writer does not expose them as caller-chosen parameters; there is nothing to choose yet, and asking a caller to name a
 * single fixed value only adds a validation surface for no reason (added back the day a second provider or side is real).
 *
 * Closed by default (`activation.ts`) — a plain library function, no route, action, scheduler entry or UI. No production
 * caller exists on purpose; registered in `scripts/pending-callers.ts` like every other ledger writer this session has built.
 */

const PROVIDER = "BCR" as const;
const PAIR = "USD/CRC" as const;
const SIDE = "SELL" as const;

/**
 * The ONLY reserved key1 for Postgres's two-integer `pg_advisory_xact_lock(key1, key2)` form in this codebase, as of this PR.
 * The two-integer form occupies a lock-key space entirely separate from the single-bigint form every existing advisory lock
 * in this codebase uses (`staff-service.ts`, `location-service.ts`, `accounting-activation.ts`, `kiosk/rate-limit.ts`) — a
 * documented Postgres guarantee, not a probabilistic one, which is why this feature does not follow those four call sites'
 * own `"namespace:orgId"` string-prefix convention (a string prefix only lowers collision probability against those specific
 * keys; it does not eliminate it). If a future feature needs its own two-integer advisory lock, it MUST choose a different
 * `key1` than this one — there is no registry enforcing that beyond this comment, so grep for `EXCHANGE_RATE_LOCK_NAMESPACE`
 * before reusing `1`.
 *
 * Residual risk, stated precisely: this guarantees separation from the four existing single-bigint locks. It does NOT
 * eliminate the possibility that two DIFFERENT organizations' `hashtext(organizationId)` values collide within this
 * reserved `key1` (`hashtext` is a 32-bit function; two distinct inputs can map to the same output). The only consequence
 * of that would be those two organizations' quote operations serializing against each other unnecessarily for the
 * duration of one transaction — never a data-correctness issue, since every row this feature touches remains scoped by
 * its own real `organizationId` column and constraints regardless of what the lock key happens to be. This is not a claim
 * that no other consequence exists anywhere in the application, and not a claim that deadlocks are impossible in general.
 */
export const EXCHANGE_RATE_LOCK_NAMESPACE = 1;

/**
 * Serializes every quote write (first entry or correction) for one organization's exchange rates — see this module's own
 * `EXCHANGE_RATE_LOCK_NAMESPACE` doc comment for why the two-integer form, and what it does and doesn't guarantee. Must be
 * the FIRST statement inside a caller's transaction, before any ledger row lock (`lockBranchShared`/`lockStudent`/etc.) —
 * a lock taken any later does not establish the ordering PR 2's settlement integration depends on. This function itself
 * never takes any other lock and never opens its own transaction.
 */
export async function lockExchangeRateNamespace(tx: Tx, organizationId: string): Promise<void> {
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which this Prisma driver adapter cannot deserialize
  // as a query result column (matches kiosk/rate-limit.ts's own single-bigint call, the one existing site with nothing
  // else to select alongside the lock).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EXCHANGE_RATE_LOCK_NAMESPACE}, hashtext(${organizationId}))`;
}

export type EnterExchangeRateQuoteError = "notActive" | "invalid" | "notFound" | "stale";

export type EnterExchangeRateQuoteResult =
  | { ok: true; quoteId: string; revision: number }
  | { ok: false; error: EnterExchangeRateQuoteError };

const refuse = (error: EnterExchangeRateQuoteError): EnterExchangeRateQuoteResult => ({ ok: false, error });

const RATE_VALUE = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/; // matches the column's own Decimal(12,6) shape
const ZERO_VALUE = /^0(\.0+)?$/; // "0", "0.0", "0.000000" — syntactically valid per RATE_VALUE but not strictly positive

/**
 * The current highest `revision` for one logical key, under whatever lock the caller already holds (this function takes
 * none itself) — 0 if no quote has ever been entered for it. Shared by `enterExchangeRateQuote` (to decide `stale`/`next`)
 * and `resolveEffectiveQuote` (to resolve "authoritative"), so the two can never disagree about what "authoritative" means.
 */
async function highestRevision(tx: Tx, organizationId: string, quoteDateDb: Date): Promise<number> {
  const rows = await tx.exchangeRateQuote.findMany({
    where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: quoteDateDb },
    select: { revision: true },
    orderBy: { revision: "desc" },
    take: 1,
  });
  return rows[0]?.revision ?? 0;
}

/**
 * One writer, both first entry and correction — see the brief's own reasoning for why a single function with an
 * `expectedCurrentRevision` (0 for "this is the first entry I know of") is what makes two simultaneous first-entry
 * attempts for the same exact date unable to both become revision 1: both take the same advisory lock; whichever
 * commits first becomes revision 1; the second, having expected 0 but the lock-protected read now finding 1, refuses
 * `stale` rather than also claiming to be revision 1.
 */
export async function enterExchangeRateQuote(
  args: {
    context: TenantContext;
    quoteDate: CalendarDate;
    /** The rate, exactly as the owner typed it — up to 6 decimal places, matching the column's own `Decimal(12,6)`. */
    value: string;
    /** 0 for what the caller believes is a first entry; the specific revision it believes it is correcting. */
    expectedCurrentRevision: number;
    sourceNote?: string;
  },
  deps: LedgerDeps = {},
): Promise<EnterExchangeRateQuoteResult> {
  const { context, quoteDate, value, expectedCurrentRevision, sourceNote } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline every
  // owner-only writer in this ledger already applies to its own role check.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");

  if (!quoteDate || !isRealDate(quoteDate)) return refuse("invalid");
  // RATE_VALUE alone accepts "0"/"0.000000" (zero is a syntactically valid decimal) — the DB's own value_positive CHECK
  // would reject it, but only after the insert, throwing instead of refusing gracefully. Caught here instead.
  if (typeof value !== "string" || !RATE_VALUE.test(value) || ZERO_VALUE.test(value)) return refuse("invalid");
  if (!Number.isInteger(expectedCurrentRevision) || expectedCurrentRevision < 0) return refuse("invalid");
  if (sourceNote !== undefined && (typeof sourceNote !== "string" || sourceNote.length > 500)) return refuse("invalid");

  const quoteDateDb = toDbDate(quoteDate);
  const trimmedNote = sourceNote && sourceNote.trim() !== "" ? sourceNote.trim() : null;

  return await prisma.$transaction(async (tx): Promise<EnterExchangeRateQuoteResult> => {
    // The literal first statement — see lockExchangeRateNamespace's own doc comment for why.
    await lockExchangeRateNamespace(tx, organizationId);

    const current = await highestRevision(tx, organizationId, quoteDateDb);
    if (current !== expectedCurrentRevision) return refuse("stale");

    const supersedes =
      current === 0
        ? null
        : await tx.exchangeRateQuote.findFirst({
            where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: quoteDateDb, revision: current },
            select: { id: true },
          });
    if (current !== 0 && !supersedes) {
      // Unreachable under the lock (the count just found a row at this revision) — checked explicitly rather than assumed.
      throw new Error(`enterExchangeRateQuote: revision ${current} disappeared under its own lock for organization ${organizationId}`);
    }

    const next = current + 1;
    const quote = await tx.exchangeRateQuote.create({
      data: {
        organizationId,
        provider: PROVIDER,
        pair: PAIR,
        side: SIDE,
        quoteDate: quoteDateDb,
        revision: next,
        value,
        enteredById: context.actorUserId,
        sourceNote: trimmedNote,
        supersedesId: supersedes?.id ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "exchangeRateQuote.enter",
        entityType: "ExchangeRateQuote",
        entityId: quote.id,
        before: supersedes ? { supersedesId: supersedes.id } : Prisma.DbNull,
        after: { quoteDate: `${quoteDate.year}-${String(quoteDate.month).padStart(2, "0")}-${String(quoteDate.day).padStart(2, "0")}`, revision: next, value, sourceNote: trimmedNote },
      },
    });

    if (deps.afterExchangeRateQuoteWrittenForTest) await deps.afterExchangeRateQuoteWrittenForTest();

    return { ok: true, quoteId: quote.id, revision: next };
  });
}

export type ResolvedQuote = { id: string; quoteDate: CalendarDate; revision: number; value: string };

/**
 * "The quote effective for `receivedOn`" (currency-conversion brief §3/§5): the exact-date match if one exists, otherwise
 * the most recent EARLIER date's own highest revision — never a later date, never any date's non-highest revision. `null`
 * if neither exists (the caller's own territory: refuse, or an awaiting-rate receipt, per whichever phase built this call).
 *
 * Takes NO lock itself. The brief's own §4.2 traces every real caller and requires the ADVISORY lock
 * (`lockExchangeRateNamespace`) to be the first statement of whichever transaction calls this — acquired by the caller,
 * before its own row locks, not by this function and not anywhere inside it. Calling this without that lock already held
 * reads a value that a concurrent correction could immediately invalidate.
 */
export async function resolveEffectiveQuote(tx: Tx, args: { organizationId: string; receivedOn: CalendarDate }): Promise<ResolvedQuote | null> {
  const { organizationId, receivedOn } = args;
  const receivedOnDb = toDbDate(receivedOn);

  const exactRevision = await highestRevision(tx, organizationId, receivedOnDb);
  if (exactRevision > 0) {
    const row = await tx.exchangeRateQuote.findFirstOrThrow({
      where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: receivedOnDb, revision: exactRevision },
      select: { id: true, quoteDate: true, revision: true, value: true },
    });
    return { id: row.id, quoteDate: fromDbDate(row.quoteDate), revision: row.revision, value: row.value.toString() };
  }

  // No exact date: the most recent EARLIER date, never a later one.
  const earlierDate = await tx.exchangeRateQuote.findFirst({
    where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: { lt: receivedOnDb } },
    select: { quoteDate: true },
    orderBy: { quoteDate: "desc" },
  });
  if (!earlierDate) return null;

  const fallbackRevision = await highestRevision(tx, organizationId, earlierDate.quoteDate);
  const row = await tx.exchangeRateQuote.findFirstOrThrow({
    where: { organizationId, provider: PROVIDER, pair: PAIR, side: SIDE, quoteDate: earlierDate.quoteDate, revision: fallbackRevision },
    select: { id: true, quoteDate: true, revision: true, value: true },
  });
  return { id: row.id, quoteDate: fromDbDate(row.quoteDate), revision: row.revision, value: row.value.toString() };
}

