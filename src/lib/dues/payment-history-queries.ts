import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { inTenantScope } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";
import { columnToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.1: a narrow, authorized, paginated ledger payment-history reader
 * for one student. A plain module, never `"use server"` — mirrors `financial-corrections-queries.ts`'s own shape.
 * "Built dark" like every other ledger reader: `LedgerActivation`-gated, no route/action/scheduler entry in this PR.
 *
 * Self-validates tenant/branch scope internally (mirrors `listCorrectableLateFees`/`listReversiblePayments`/
 * `listDuesFactsForStudents` — NOT `get-payment-history.ts`'s trust-the-caller contract). An id outside the
 * caller's own organization or branch scope is treated exactly like "no such student" — a genuinely empty
 * success, never a distinguishable error (no different information is leaked).
 *
 * Gap A (brief): settlements are NEVER filtered by `reversedAt` — unlike `listReversiblePayments`'s own candidate
 * list, a reversed payment must keep its full, original settlement detail (obligation breakdown, which late fee
 * it included, if any) exactly as it was at settlement time.
 *
 * Gap B: `DuesSettlement.lateFeeId` is the historical fact of which fee (if any) THIS settlement included — reported
 * alongside that fee's CURRENT `removalKind` (a separate, later-mutable fact).
 *
 * Gap C: cross-currency evidence (`appliedRateId`/`appliedRateValue`/`appliedRateQuoteDate`/`appliedRateRevision`/
 * `appliedRoundingRule`) lives on the PAYMENT row, snapshotted at settlement time — read directly off the stored
 * row here, never recomputed or re-joined against the (possibly since-corrected) live quote.
 *
 * Amounts are derived, never stored: principal = `obligation.amount`; included fee = `obligation.lateFeeAmount`
 * IFF this settlement's own `lateFeeId` is non-null; total = the exact sum of the two — never `lateFeeToAssessMinor`,
 * which answers a different, present-tense question ("is a fee owed right now").
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface PaymentHistorySettlementRow {
  id: string;
  reversedAt: string | null;
  obligationId: string;
  obligationType: "MONTHLY" | "SIGNUP" | "PACKAGE";
  coverageYear: number;
  coverageMonth: number;
  currency: Currency;
  principalAmount: string;
  /** Non-null iff this settlement's own `lateFeeId` was set — the fee it actually included at settlement time. */
  lateFee: { id: string; amount: string; removalKind: "VOIDED" | "WAIVED" | null } | null;
  /** `principalAmount` + (`lateFee.amount` if present) — exact sum, never re-derived via `lateFeeToAssessMinor`. */
  totalAmount: string;
}

export interface PaymentHistoryRow {
  id: string;
  receivedOn: { year: number; month: number; day: number };
  tenderCurrency: Currency;
  tenderAmount: string;
  method: PaymentMethod;
  notes: string | null;
  reversedAt: string | null;
  /** `null` for a same-currency payment — see `DuesPayment.appliedRateId` (Gap C). */
  conversion: {
    appliedRateId: string;
    appliedRateValue: string;
    appliedRateQuoteDate: { year: number; month: number; day: number };
    appliedRateRevision: number;
    appliedRoundingRule: string;
  } | null;
  settlements: PaymentHistorySettlementRow[];
}

/**
 * Brief §7: distinct outcomes, never collapsed into one another — `notActive` (the ledger isn't live for this
 * organization), a genuinely empty success (`ok: true, rows: []`, e.g. no payments yet, or a student outside this
 * caller's own scope), and `ok: false, error: "invalid"` for malformed INPUT (caught by `isNonBlankString` before
 * any database access is attempted).
 *
 * This union has no member for an operational database failure. A real rejection from the underlying read (a
 * connection error, a transient failure) is NOT caught and converted into any typed result here — it propagates
 * as a rejected promise, exactly like any other unhandled `await` in this codebase. Callers that need a typed
 * outcome for that case must catch it themselves; this function's own contract has never promised otherwise.
 */
export type PaymentHistoryResult = { ok: true; rows: PaymentHistoryRow[]; nextCursor: string | null } | { ok: false; error: "invalid" | "notActive" };

export async function listPaymentHistoryForStudent(
  context: TenantContext,
  studentId: string,
  opts: { limit?: number; cursor?: string } = {},
  deps: LedgerDeps = {},
): Promise<PaymentHistoryResult> {
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(context.organizationId))) return { ok: false, error: "notActive" };
  if (!isNonBlankString(studentId)) return { ok: false, error: "invalid" };

  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: true, rows: [], nextCursor: null };

  const where = { organizationId: context.organizationId, studentId } as const;
  const limit = clampLimit(opts.limit);

  // Tenant/student-bound cursor validation, same discipline as `financial-corrections-queries.ts`: a foreign
  // cursor is silently ignored (falls back to page 1), never trusted to peek into another student's page. Deliberately
  // NOT scoped by `reversedAt` — a reversed payment is still a legitimate cursor target.
  let cursorId: string | undefined;
  if (isNonBlankString(opts.cursor)) {
    const owns = await prisma.duesPayment.findFirst({ where: { id: opts.cursor, ...where }, select: { id: true } });
    if (owns) cursorId = owns.id;
  }

  const payments = await prisma.duesPayment.findMany({
    where,
    orderBy: [{ receivedOn: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: {
      id: true,
      receivedOn: true,
      tenderCurrency: true,
      tenderAmount: true,
      method: true,
      notes: true,
      reversedAt: true,
      appliedRateId: true,
      appliedRateValue: true,
      appliedRateQuoteDate: true,
      appliedRateRevision: true,
      appliedRoundingRule: true,
      settlements: {
        select: {
          id: true,
          reversedAt: true,
          lateFeeId: true,
          obligation: { select: { id: true, type: true, coverageYear: true, coverageMonth: true, currency: true, amount: true, lateFeeAmount: true } },
          lateFee: { select: { id: true, removalKind: true } },
        },
      },
    },
  });

  const hasMore = payments.length > limit;
  const page = hasMore ? payments.slice(0, limit) : payments;

  const rows: PaymentHistoryRow[] = page.map((p) => ({
    id: p.id,
    receivedOn: { year: p.receivedOn.getUTCFullYear(), month: p.receivedOn.getUTCMonth() + 1, day: p.receivedOn.getUTCDate() },
    tenderCurrency: p.tenderCurrency,
    tenderAmount: p.tenderAmount.toFixed(2),
    method: p.method,
    notes: p.notes,
    reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
    conversion:
      p.appliedRateId && p.appliedRateValue && p.appliedRateQuoteDate && p.appliedRateRevision !== null && p.appliedRoundingRule
        ? {
            appliedRateId: p.appliedRateId,
            appliedRateValue: p.appliedRateValue.toString(),
            appliedRateQuoteDate: { year: p.appliedRateQuoteDate.getUTCFullYear(), month: p.appliedRateQuoteDate.getUTCMonth() + 1, day: p.appliedRateQuoteDate.getUTCDate() },
            appliedRateRevision: p.appliedRateRevision,
            appliedRoundingRule: p.appliedRoundingRule,
          }
        : null,
    settlements: p.settlements.map((s) => {
      const principalAmount = s.obligation.amount.toFixed(2);
      // Gap B: `s.lateFeeId` (this SETTLEMENT's own historical fact) gates inclusion — never "does the obligation
      // currently have a fee row," which would wrongly attribute a fee assessed AFTER this settlement.
      const lateFee = s.lateFeeId && s.lateFee ? { id: s.lateFee.id, amount: s.obligation.lateFeeAmount!.toFixed(2), removalKind: s.lateFee.removalKind } : null;
      // Exact minor-unit sum (never floating-point `Number()` addition) — the same discipline `minor-units.ts` enforces everywhere else.
      const totalAmount = minorToDecimal(columnToMinor(s.obligation.amount) + (lateFee ? columnToMinor(s.obligation.lateFeeAmount!) : 0));
      return {
        id: s.id,
        reversedAt: s.reversedAt ? s.reversedAt.toISOString() : null,
        obligationId: s.obligation.id,
        obligationType: s.obligation.type,
        coverageYear: s.obligation.coverageYear,
        coverageMonth: s.obligation.coverageMonth,
        currency: s.obligation.currency,
        principalAmount,
        lateFee,
        totalAmount,
      };
    }),
  }));

  return { ok: true, rows, nextCursor: hasMore ? page[page.length - 1].id : null };
}
