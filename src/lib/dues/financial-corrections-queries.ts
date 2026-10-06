import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { versionRevision } from "@/lib/dues/config-input";
import { inTenantScope } from "@/lib/dues/ledger/common";

/**
 * Owner financial-corrections UI brief §2.2: the three genuinely new reads this card needs — none of
 * `payments-table.tsx`/`dues-facts.ts` lists an individual `DuesLateFee`/`DuesPayment` row for selection (brief §1,
 * confirmed directly). A plain module, never `"use server"` — mirrors `package-purchase-queries.ts`/
 * `awaiting-rate-receipt-queries.ts`'s own established shape.
 *
 * `expectedRevision` is computed server-side here via `versionRevision` — the EXACT helper
 * `correctLateFeeAndSettle`/`waiveLateFee` each already use internally for their own `lateFeeRevision` — never
 * recomputed client-side (brief §2.2's own corrected wording).
 *
 * Correction round 2: both list reads are now cursor-paginated (a page-size cap alone made older records
 * permanently unreachable). The cursor itself is tenant/student-bound — a cursor id that doesn't genuinely belong to
 * THIS student+organization is ignored (treated as no cursor, i.e. page 1) rather than trusted blindly; a client
 * could otherwise probe for a foreign row's existence by watching whether a crafted cursor changes the result shape.
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

/** Mirrors `correct-late-fee.ts`/`waive-late-fee.ts`'s own private `lateFeeRevision` exactly — the same shape,
 * computed here so the two writers' own internal helper never needs exporting just for this read to reuse it. */
function lateFeeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

export interface ListPage<T> {
  rows: T[];
  /** The id to pass back as `cursor` to fetch the next page; `null` once there is nothing older left. */
  nextCursor: string | null;
}

export interface CorrectableLateFeeRow {
  id: string;
  expectedRevision: string;
  obligationId: string;
  coverageYear: number;
  coverageMonth: number;
  amount: string;
  currency: string;
  /** Correction round 2: the obligation's own (tuition) amount — separate from `amount` (the late fee itself) and
   * NEVER wired as a tender-amount default. Reference context only, so the owner can tell the two numbers apart. */
  obligationAmount: string;
  graceDeadline: { year: number; month: number; day: number };
}

/** Brief §2.2: a student's own unremoved (`removedAt: null`) `DuesLateFee` rows — the shared candidate list feeding
 * BOTH the correction and waiver flows (brief §3 decision 3). Bounded (§2.2's own DoS/usability guard, same spirit
 * as PR #93's `MAX_MONTHS_PER_REQUEST`), tenant/branch-scoped like every other read in this ledger, cursor-paginated
 * (correction round 2). */
export async function listCorrectableLateFees(
  context: TenantContext,
  studentId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ListPage<CorrectableLateFeeRow>> {
  if (!isNonBlankString(studentId)) return { rows: [], nextCursor: null };
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { rows: [], nextCursor: null };

  const where = { organizationId: context.organizationId, removedAt: null, obligation: { studentId } } as const;
  const limit = clampLimit(opts.limit);

  // Tenant/student-bound cursor validation: a cursor id must genuinely be one of THIS student's own unremoved fees
  // before it is trusted — otherwise silently ignored (falls back to page 1), never used to peek past another
  // student's or another org's row.
  let cursorId: string | undefined;
  if (isNonBlankString(opts.cursor)) {
    const owns = await prisma.duesLateFee.findFirst({ where: { id: opts.cursor, ...where }, select: { id: true } });
    if (owns) cursorId = owns.id;
  }

  const fees = await prisma.duesLateFee.findMany({
    where,
    orderBy: [{ assessedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: {
      id: true,
      removedAt: true,
      removalKind: true,
      obligation: { select: { id: true, coverageYear: true, coverageMonth: true, amount: true, currency: true, lateFeeAmount: true, graceDeadline: true } },
    },
  });

  const hasMore = fees.length > limit;
  const page = hasMore ? fees.slice(0, limit) : fees;

  const rows = page
    .filter((f) => f.obligation.graceDeadline !== null && f.obligation.lateFeeAmount !== null)
    .map((f) => ({
      id: f.id,
      expectedRevision: lateFeeRevision(f),
      obligationId: f.obligation.id,
      coverageYear: f.obligation.coverageYear,
      coverageMonth: f.obligation.coverageMonth,
      amount: f.obligation.lateFeeAmount!.toFixed(2),
      currency: f.obligation.currency,
      obligationAmount: f.obligation.amount.toFixed(2),
      graceDeadline: { year: f.obligation.graceDeadline!.getUTCFullYear(), month: f.obligation.graceDeadline!.getUTCMonth() + 1, day: f.obligation.graceDeadline!.getUTCDate() },
    }));

  return { rows, nextCursor: hasMore ? page[page.length - 1].id : null };
}

export interface ReversiblePaymentRow {
  id: string;
  receivedOn: { year: number; month: number; day: number };
  tenderCurrency: string;
  tenderAmount: string;
  method: string;
  /** Brief §2.2/§3 decision 4: enough context for the UI to show a specific, named, advisory (never authoritative)
   * restriction explanation per settled obligation, never a silent client-side filter. */
  restrictions: {
    /** `unsupportedObligationType` would refuse — covers BOTH a package-origin and a signup-type obligation; the
     * refusal itself cannot distinguish which (brief §1), so neither can this flag's own name. */
    hasUnsupportedObligationType: boolean;
    hasPrepaymentOrigin: boolean;
    hasVoidedFee: boolean;
  };
}

/** Brief §2.2: a student's own recent, not-yet-reversed `DuesPayment` rows — the reversal candidate list. Bounded,
 * tenant/branch-scoped, each row carrying its settled obligations' own restriction shape for the advisory
 * visible-but-disabled treatment (brief §3 decision 4) — never pre-filtered/hidden. Cursor-paginated (correction
 * round 2), same tenant/student-bound cursor validation as the fee list above. */
export async function listReversiblePayments(
  context: TenantContext,
  studentId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ListPage<ReversiblePaymentRow>> {
  if (!isNonBlankString(studentId)) return { rows: [], nextCursor: null };
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { rows: [], nextCursor: null };

  const where = { organizationId: context.organizationId, studentId, reversedAt: null } as const;
  const limit = clampLimit(opts.limit);

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
      settlements: {
        where: { reversedAt: null },
        select: { obligation: { select: { type: true, origin: true, lateFees: { select: { removalKind: true } } } } },
      },
    },
  });

  const hasMore = payments.length > limit;
  const page = hasMore ? payments.slice(0, limit) : payments;

  const rows = page.map((p) => {
    const obligations = p.settlements.map((s) => s.obligation);
    return {
      id: p.id,
      receivedOn: { year: p.receivedOn.getUTCFullYear(), month: p.receivedOn.getUTCMonth() + 1, day: p.receivedOn.getUTCDate() },
      tenderCurrency: p.tenderCurrency,
      tenderAmount: p.tenderAmount.toFixed(2),
      method: p.method,
      restrictions: {
        hasUnsupportedObligationType: obligations.some((o) => o.type !== "MONTHLY"),
        hasPrepaymentOrigin: obligations.some((o) => o.origin === "PREPAYMENT"),
        hasVoidedFee: obligations.some((o) => o.lateFees.some((f) => f.removalKind === "VOIDED")),
      },
    };
  });

  return { rows, nextCursor: hasMore ? page[page.length - 1].id : null };
}

export interface LateFeeStatus {
  id: string;
  removedAt: string | null;
  removalKind: "VOIDED" | "WAIVED" | null;
  expectedRevision: string;
}

/** Brief §2.2/§2.5: the recovery read for a late fee — a single-record lookup by id, tenant/branch-scoped like the
 * list above, but NEVER filtered by `removedAt`. Must find the exact target even after it has left the correctable
 * candidate list (because an earlier, uncertain attempt actually succeeded) — a parameterized form of the list query
 * above would silently fail to find it; this is a separate read. Never paginated — a single row by id. */
export async function getLateFeeById(context: TenantContext, feeId: string): Promise<LateFeeStatus | null> {
  if (!isNonBlankString(feeId)) return null;
  const fee = await prisma.duesLateFee.findFirst({
    where: { id: feeId, organizationId: context.organizationId },
    select: { id: true, removedAt: true, removalKind: true, obligation: { select: { academyId: true } } },
  });
  if (!fee || !inTenantScope(context, fee.obligation.academyId)) return null;
  return { id: fee.id, removedAt: fee.removedAt ? fee.removedAt.toISOString() : null, removalKind: fee.removalKind, expectedRevision: lateFeeRevision(fee) };
}

export interface PaymentStatus {
  id: string;
  reversedAt: string | null;
}

/** `getLateFeeById`'s own exact counterpart for a payment — never filtered by `reversedAt`, same reasoning. Never
 * paginated. */
export async function getPaymentById(context: TenantContext, paymentId: string): Promise<PaymentStatus | null> {
  if (!isNonBlankString(paymentId)) return null;
  const payment = await prisma.duesPayment.findFirst({ where: { id: paymentId, organizationId: context.organizationId }, select: { id: true, reversedAt: true, academyId: true } });
  if (!payment || !inTenantScope(context, payment.academyId)) return null;
  return { id: payment.id, reversedAt: payment.reversedAt ? payment.reversedAt.toISOString() : null };
}
