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
 * Currency-conversion brief, PR 2 correction: a genuine reader/writer split on this same reserved key, after PR 2's first
 * cut (a single, always-EXCLUSIVE lock on this key) turned out to serialize every settlement for an organization against
 * every other settlement, not just against a genuine rate correction — a real scalability regression discovered by
 * re-reading a test's own comment rather than reasoning through what "acquired unconditionally, before any row lock" a
 * shared/inner mode of a lock actually does under concurrent settlements. Postgres's advisory locks support this split
 * NATIVELY, on the identical `(key1, key2)` pair: `pg_advisory_xact_lock_shared` (many holders, none of which conflict
 * with each other) versus `pg_advisory_xact_lock` (one holder, conflicts with every shared AND every exclusive holder).
 *
 *   - EXCLUSIVE (`lockExchangeRateNamespaceExclusive`, below): held by `enterExchangeRateQuote` alone (a rate's first
 *     entry or correction — an occasional, owner-initiated administrative action, never a per-payment hot path).
 *   - SHARED (`lockExchangeRateNamespaceShared`, below): held by all four settlement writers (`recordDuesPayment`,
 *     `correctLateFeeAndSettle`, `prepayMonthlyObligations`, `purchasePackage`). Many settlements — same student,
 *     different students, same organization or different ones, same currency or cross-currency — hold the shared lock
 *     simultaneously with NO contention among themselves; only a concurrent EXCLUSIVE request (a correction) genuinely
 *     waits for every currently-open shared holder to release, and no new shared holder can be granted while an
 *     exclusive holder has the lock. This is the actual fix: it closes the real race (a settlement using a rate value a
 *     correction is simultaneously replacing) without re-serializing ordinary payment traffic against itself.
 *
 * BOTH remain the literal FIRST statement inside a caller's transaction, before any ledger row lock
 * (`lockBranchShared`/`lockStudent`/etc.) — only the MODE changed from PR 2's first cut, never the position in the
 * sequence or the reserved key. Neither function takes any other lock or opens its own transaction.
 *
 * THE REMAINING TRADE-OFF, STATED PLAINLY, NOT MINIMIZED: a quote entry or correction (the EXCLUSIVE holder) can still
 * temporarily block EVERY open settlement for that organization from even acquiring the SHARED lock — including
 * same-currency ones, since this lock is taken unconditionally regardless of whether conversion is ever needed by that
 * particular settlement. This is a real cost, just a far smaller and far rarer one than the regression it replaces: an
 * owner entering or correcting a rate is an occasional administrative action, not something that happens per payment.
 */
export async function lockExchangeRateNamespaceShared(tx: Tx, organizationId: string): Promise<void> {
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock_shared returns void, which this Prisma driver adapter cannot
  // deserialize as a query result column (matches kiosk/rate-limit.ts's own single-bigint call, the one existing site
  // with nothing else to select alongside the lock).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${EXCHANGE_RATE_LOCK_NAMESPACE}, hashtext(${organizationId}))`;
}

// TRANSACTION-TIMEOUT BEHAVIOR, observed directly, not assumed (no caller anywhere sets `timeout`/`maxWait`, so
// Prisma's own defaults govern every transaction in this ledger: `timeout: 5000`ms, `maxWait: 2000`ms — verified
// against this exact Prisma version, not read from documentation alone). If a transaction blocks on either lock
// function above longer than its own 5-second budget, Postgres does NOT get told to cancel the wait: the blocking
// query genuinely sits until the lock is actually granted, however long that takes. Only once the response finally
// arrives does Prisma's client notice its own deadline already passed and refuse to use it, rejecting with
// PrismaClientKnownRequestError (code "P2028", "...cannot be executed on an expired transaction...") — never a typed
// { ok: false, error: ... } refusal from any writer in this file, since no classifier here recognizes P2028 (only
// specific unique-constraint violations are). A caller of any of the four settlement writers, or of
// enterExchangeRateQuote, must be ready for this to REJECT, not just resolve to a refusal object. Confirmed clean on
// the way out: Prisma properly ends the underlying database transaction when this happens, and the lock it held is
// genuinely released — no orphaned pg_locks row, no stuck session, verified by a subsequent unrelated attempt
// proceeding immediately afterward. No retry logic exists for this anywhere in this ledger, and none is added here.
// In the observed configuration, the blocked request continues occupying a database connection until the lock wait
// ends, even after Prisma's transaction deadline has elapsed; sustained contention can therefore reduce available
// pool capacity. (Transaction-mode pooling was not tested here — this observation is against the direct connection
// this test suite and this codebase's own pool both use, nothing more is claimed.)

/** See `lockExchangeRateNamespaceShared`'s own doc comment for the full reader/writer design. Held only by
 * `enterExchangeRateQuote` — a rate's first entry or correction — never by a settlement writer. */
export async function lockExchangeRateNamespaceExclusive(tx: Tx, organizationId: string): Promise<void> {
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
    // The literal first statement, EXCLUSIVE — see lockExchangeRateNamespaceShared's own doc comment for the full
    // reader/writer design and why this write path is the one caller that must never use the shared mode.
    await lockExchangeRateNamespaceExclusive(tx, organizationId);

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
 * Takes NO lock itself. The brief's own §4.2 traces every real caller and requires the SHARED advisory lock
 * (`lockExchangeRateNamespaceShared` — never the exclusive mode, which only a rate write itself takes) to be the first
 * statement of whichever transaction calls this — acquired by the caller, before its own row locks, not by this
 * function and not anywhere inside it. Calling this without that lock already held reads a value that a concurrent
 * correction could immediately invalidate.
 *
 * ASSUMES READ COMMITTED (Postgres's own default, and this codebase's actual behavior — no caller anywhere sets
 * `isolationLevel`, verified). Confirmed by direct experiment (currency-conversion brief §4.4): under READ COMMITTED,
 * a settlement that wakes from a blocked SHARED-lock wait genuinely sees a correction that committed while it waited —
 * this function's own "closes the race" guarantee depends on that. Forcing the caller's transaction to REPEATABLE READ
 * instead reproduces staleness directly: the settlement's snapshot is fixed before the wait even resolves, so this
 * function silently returns the PRE-correction revision even though the correction has already committed by the time
 * this runs. If any caller's transaction is ever changed to REPEATABLE READ or SERIALIZABLE, this guarantee breaks
 * silently — re-verify against a real concurrent correction before doing so, don't assume READ COMMITTED forever.
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

