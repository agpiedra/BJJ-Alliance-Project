import { z } from "zod";
import { PaymentMethod, type Currency, type AwaitingRateReceiptStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { parseMoney } from "@/lib/dues/config-input";
import type { CalendarDate, YearMonth } from "@/lib/dues/calendar";
import { inTenantScope, isRealDate } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { lockExchangeRateNamespaceShared } from "@/lib/dues/ledger/exchange-rate";
import { isValidCoverageMonth } from "@/lib/dues/ledger/create-monthly-obligation";
import { classifyRecordPaymentError } from "@/lib/dues/ledger/record-payment";
import {
  purchasePackageInTx,
  PackagePurchaseRefusedError,
  MAX_EXISTING_DEBT,
  MAX_BACKDATE_DAYS as PACKAGE_MAX_BACKDATE_DAYS,
  MAX_NOTES as PACKAGE_MAX_NOTES,
  type PurchasePackageResult,
} from "@/lib/dues/ledger/purchase-package";
import {
  prepayMonthlyObligationsInTx,
  PrepaymentRefusedError,
  MAX_BACKDATE_DAYS as PREPAY_MAX_BACKDATE_DAYS,
  MAX_NOTES as PREPAY_MAX_NOTES,
  type PrepayMonthlyObligationsResult,
} from "@/lib/dues/ledger/prepay-monthly";
import { readPaymentReversalStatus, readReceiptStatus } from "@/lib/dues/ledger/submission-identity";
import { CURRENCIES } from "@/lib/payments/format-money";

/**
 * Prepayment/package-purchase UI brief §2.6: the purchase-submission-identity prerequisite — the SAME
 * lock-order/identity-arbitration/rollback mechanism `recordDuesPaymentWithSubmissionIdentity`
 * (`submission-identity.ts`) already proved, composed here around `purchasePackageInTx`/
 * `prepayMonthlyObligationsInTx` (the narrow transaction-aware extractions `purchase-package.ts`/
 * `prepay-monthly.ts` now expose) instead of `recordDuesPaymentInTx` — never `purchasePackage`/
 * `prepayMonthlyObligations` themselves, which each open their OWN transaction and cannot be composed this way.
 *
 * Both `submissionId`s share the SAME `DuesPaymentAttempt` table and the SAME
 * `@@unique([organizationId, submissionId])` constraint the ordinary writer already uses — no new migration. Every
 * canonical payload here carries an explicit `operation` discriminator (`"PACKAGE"` / `"PREPAYMENT"`), compared
 * like any other field — a cross-writer submissionId collision (astronomically unlikely with
 * `crypto.randomUUID()`, never assumed away) is caught by BOTH the schemas' own disjoint required-field shapes
 * (a foreign row fails `safeParse` outright) AND the explicit `operation` comparison, never relying on shape
 * alone.
 */

const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const yearMonthSchema = z.object({ year: z.number().int(), month: z.number().int() });
const sameYearMonth = (a: { year: number; month: number }, b: { year: number; month: number }) => a.year === b.year && a.month === b.month;

// ---- PACKAGE ----------------------------------------------------------------------------------------------------

const packageCanonicalPayloadSchema = z.object({
  operation: z.literal("PACKAGE"),
  studentId: z.string().min(1),
  planTermsId: z.string().min(1),
  requestedStartMonth: yearMonthSchema,
  existingObligationIds: z.array(z.string().min(1)),
  receivedOn: z.string().min(1),
  tenderCurrency: z.string().min(1),
  tenderAmount: z.string().min(1),
  method: z.string().min(1),
  notes: z.string(),
});
type PackageCanonicalPayload = z.infer<typeof packageCanonicalPayloadSchema>;

function canonicalizePackageSubmission(args: {
  studentId: string;
  planTermsId: string;
  requestedStartMonth: YearMonth;
  existingObligationIds?: string[];
  receivedOn: CalendarDate;
  tender: { currency: Currency; amount: string };
  method: PaymentMethod;
  notes?: string;
}): PackageCanonicalPayload {
  const parsedAmount = parseMoney(args.tender.amount, { allowZero: false });
  if (!parsedAmount.ok) {
    throw new Error(`canonicalizePackageSubmission called with an amount that failed the caller's own validation: ${args.tender.amount}`);
  }
  return {
    operation: "PACKAGE",
    studentId: args.studentId,
    planTermsId: args.planTermsId,
    requestedStartMonth: { year: args.requestedStartMonth.year, month: args.requestedStartMonth.month },
    existingObligationIds: [...(args.existingObligationIds ?? [])].sort(),
    receivedOn: ymd(args.receivedOn),
    tenderCurrency: args.tender.currency,
    tenderAmount: parsedAmount.value,
    method: args.method,
    notes: args.notes && args.notes.trim() !== "" ? args.notes.trim() : "",
  };
}

function packagePayloadsEqual(a: PackageCanonicalPayload, b: PackageCanonicalPayload): boolean {
  return (
    a.operation === b.operation &&
    a.studentId === b.studentId &&
    a.receivedOn === b.receivedOn &&
    a.tenderCurrency === b.tenderCurrency &&
    a.tenderAmount === b.tenderAmount &&
    a.method === b.method &&
    a.notes === b.notes &&
    a.planTermsId === b.planTermsId &&
    sameYearMonth(a.requestedStartMonth, b.requestedStartMonth) &&
    a.existingObligationIds.length === b.existingObligationIds.length &&
    a.existingObligationIds.every((id, i) => id === b.existingObligationIds[i])
  );
}

/** Mirrors `SubmissionRefusedError` (`submission-identity.ts`) exactly — tags a mid-transaction identity-layer
 * refusal (payload mismatch) so it can be thrown, forcing Prisma to roll back the identity INSERT, then converted
 * back to a plain result only AFTER rollback, in the outer catch. Never used for `captured`/`ok:true` (committed
 * outcomes, returned normally). Distinct from `PackagePurchaseRefusedError` (the INNER writer's own business
 * refusal, propagated unchanged) — the outer catch below distinguishes both. */
class PackageSubmissionRefusedError extends Error {
  constructor(public readonly result: PurchasePackageWithSubmissionIdentityResult & { ok: false }) {
    super(`package purchase submission refused mid-transaction: ${result.error}`);
  }
}

export type PurchasePackageWithSubmissionIdentityResult =
  | (PurchasePackageResult & { ok: true })
  | { ok: true; paymentId: string; replay: true; currentlyReversed: boolean }
  | (PurchasePackageResult & { ok: false })
  | { ok: false; error: "captured"; receiptId: string; replay: true; currentStatus: AwaitingRateReceiptStatus }
  | { ok: false; error: "submissionPayloadMismatch" };

/**
 * Record ONE package purchase, idempotently keyed by the caller's own `submissionId` — the identical contract
 * `recordDuesPaymentWithSubmissionIdentity` already established for ordinary payments, applied here to
 * `purchasePackageInTx`. `submissionId` is REQUIRED, never generated here (minting it server-side would defeat
 * the entire point of a client-supplied retry key).
 *
 * LOCK ORDER: the identity insert sits AFTER `lockExchangeRateNamespaceShared` (the literal first statement,
 * exactly like `purchasePackage`'s own) and BEFORE the writer's own branch/student locks, taken inside
 * `purchasePackageInTx` — a losing/replay request never reaches those locks at all.
 */
export async function purchasePackageWithSubmissionIdentity(
  args: {
    context: TenantContext;
    studentId: string;
    planTermsId: string;
    requestedStartMonth: YearMonth;
    existingObligationIds?: string[];
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    maxBackdateDays: number;
    submissionId: string;
  },
  deps: LedgerDeps = {},
): Promise<PurchasePackageWithSubmissionIdentityResult> {
  const { context, studentId, planTermsId, requestedStartMonth, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays, submissionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };
  if (context.organizationRole !== "ADMIN") return { ok: false, error: "notFound" };

  if (typeof studentId !== "string" || studentId === "") return { ok: false, error: "invalid" };
  if (typeof submissionId !== "string" || submissionId.trim() === "") return { ok: false, error: "invalid" };
  if (typeof planTermsId !== "string" || planTermsId === "") return { ok: false, error: "invalid" };
  if (!requestedStartMonth || !isValidCoverageMonth(requestedStartMonth)) return { ok: false, error: "invalid" };
  if (
    existingObligationIds !== undefined &&
    (!Array.isArray(existingObligationIds) ||
      existingObligationIds.length > MAX_EXISTING_DEBT ||
      existingObligationIds.some((id) => typeof id !== "string" || id === "") ||
      new Set(existingObligationIds).size !== existingObligationIds.length)
  ) {
    return { ok: false, error: "invalid" };
  }
  if (!receivedOn || !isRealDate(receivedOn)) return { ok: false, error: "invalid" };
  if (!(CURRENCIES as readonly string[]).includes(tender?.currency)) return { ok: false, error: "invalid" };
  const parsedAmount = parseMoney(tender?.amount, { allowZero: false });
  if (!parsedAmount.ok) return { ok: false, error: "invalid" };
  if (!(Object.values(PaymentMethod) as string[]).includes(method)) return { ok: false, error: "invalid" };
  if (notes !== undefined && (typeof notes !== "string" || notes.length > PACKAGE_MAX_NOTES)) return { ok: false, error: "invalid" };
  if (!Number.isInteger(maxBackdateDays) || maxBackdateDays < 0 || maxBackdateDays > PACKAGE_MAX_BACKDATE_DAYS) return { ok: false, error: "invalid" };

  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, error: "notFound" };

  const canonical = canonicalizePackageSubmission({ studentId, planTermsId, requestedStartMonth, existingObligationIds, receivedOn, tender, method, notes });

  try {
    return await prisma.$transaction(async (tx): Promise<PurchasePackageWithSubmissionIdentityResult> => {
      await lockExchangeRateNamespaceShared(tx, organizationId);
      if (deps.afterExchangeRateLockForTest) await deps.afterExchangeRateLockForTest();

      const newId = crypto.randomUUID();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "DuesPaymentAttempt" ("id", "organizationId", "studentId", "academyId", "submissionId", "canonicalPayload")
        VALUES (${newId}, ${organizationId}, ${student.id}, ${student.homeAcademyId}, ${submissionId}, ${JSON.stringify(canonical)}::jsonb)
        ON CONFLICT ("organizationId", "submissionId") DO NOTHING
        RETURNING "id"
      `;
      if (deps.afterSubmissionIdentityInsertForTest) await deps.afterSubmissionIdentityInsertForTest(tx);

      if (inserted.length > 0) {
        const attemptId = inserted[0].id;
        const result = await purchasePackageInTx(tx, { context, student, planTermsId, requestedStartMonth, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays }, deps);
        if (result.ok) {
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { paymentId: result.paymentId } });
          return result;
        }
        if (result.error === "captured") {
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { receiptId: result.receiptId } });
          return result;
        }
        throw new PackageSubmissionRefusedError(result);
      }

      const existing = await tx.duesPaymentAttempt.findFirst({
        where: { organizationId, submissionId },
        select: { canonicalPayload: true, paymentId: true, receiptId: true },
      });
      if (!existing) {
        throw new Error(`DuesPaymentAttempt insert conflicted for submission ${submissionId} but no row was found immediately after — impossible under ON CONFLICT DO NOTHING`);
      }
      const parsedExisting = packageCanonicalPayloadSchema.safeParse(existing.canonicalPayload);
      if (!parsedExisting.success || !packagePayloadsEqual(parsedExisting.data, canonical)) {
        return { ok: false, error: "submissionPayloadMismatch" };
      }
      if (existing.paymentId) {
        const currentlyReversed = await readPaymentReversalStatus(tx, organizationId, existing.paymentId);
        return { ok: true, paymentId: existing.paymentId, replay: true, currentlyReversed };
      }
      if (existing.receiptId) {
        const currentStatus = await readReceiptStatus(tx, organizationId, existing.receiptId);
        return { ok: false, error: "captured", receiptId: existing.receiptId, replay: true, currentStatus };
      }
      throw new Error(`DuesPaymentAttempt row for submission ${submissionId} (organization ${organizationId}) has neither paymentId nor receiptId set`);
    });
  } catch (error) {
    if (error instanceof PackageSubmissionRefusedError) return error.result;
    if (error instanceof PackagePurchaseRefusedError) return error.result;
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as PurchasePackageWithSubmissionIdentityResult;
    throw error;
  }
}

// ---- PREPAYMENT --------------------------------------------------------------------------------------------------

const prepaymentCanonicalPayloadSchema = z.object({
  operation: z.literal("PREPAYMENT"),
  studentId: z.string().min(1),
  requestedMonths: z.array(yearMonthSchema),
  existingObligationIds: z.array(z.string().min(1)),
  receivedOn: z.string().min(1),
  tenderCurrency: z.string().min(1),
  tenderAmount: z.string().min(1),
  method: z.string().min(1),
  notes: z.string(),
});
type PrepaymentCanonicalPayload = z.infer<typeof prepaymentCanonicalPayloadSchema>;

function canonicalizePrepaymentSubmission(args: {
  studentId: string;
  requestedMonths: YearMonth[];
  existingObligationIds?: string[];
  receivedOn: CalendarDate;
  tender: { currency: Currency; amount: string };
  method: PaymentMethod;
  notes?: string;
}): PrepaymentCanonicalPayload {
  const parsedAmount = parseMoney(args.tender.amount, { allowZero: false });
  if (!parsedAmount.ok) {
    throw new Error(`canonicalizePrepaymentSubmission called with an amount that failed the caller's own validation: ${args.tender.amount}`);
  }
  return {
    operation: "PREPAYMENT",
    studentId: args.studentId,
    requestedMonths: [...args.requestedMonths].map((m) => ({ year: m.year, month: m.month })).sort((a, b) => a.year - b.year || a.month - b.month),
    existingObligationIds: [...(args.existingObligationIds ?? [])].sort(),
    receivedOn: ymd(args.receivedOn),
    tenderCurrency: args.tender.currency,
    tenderAmount: parsedAmount.value,
    method: args.method,
    notes: args.notes && args.notes.trim() !== "" ? args.notes.trim() : "",
  };
}

function prepaymentPayloadsEqual(a: PrepaymentCanonicalPayload, b: PrepaymentCanonicalPayload): boolean {
  return (
    a.operation === b.operation &&
    a.studentId === b.studentId &&
    a.receivedOn === b.receivedOn &&
    a.tenderCurrency === b.tenderCurrency &&
    a.tenderAmount === b.tenderAmount &&
    a.method === b.method &&
    a.notes === b.notes &&
    a.requestedMonths.length === b.requestedMonths.length &&
    a.requestedMonths.every((m, i) => sameYearMonth(m, b.requestedMonths[i])) &&
    a.existingObligationIds.length === b.existingObligationIds.length &&
    a.existingObligationIds.every((id, i) => id === b.existingObligationIds[i])
  );
}

/** See `PackageSubmissionRefusedError`'s own doc comment — the identical mechanism for the prepayment wrapper. */
class PrepaymentSubmissionRefusedError extends Error {
  constructor(public readonly result: PrepayMonthlyObligationsWithSubmissionIdentityResult & { ok: false }) {
    super(`prepayment submission refused mid-transaction: ${result.error}`);
  }
}

export type PrepayMonthlyObligationsWithSubmissionIdentityResult =
  | (PrepayMonthlyObligationsResult & { ok: true })
  | { ok: true; paymentId: string; replay: true; currentlyReversed: boolean }
  | (PrepayMonthlyObligationsResult & { ok: false })
  | { ok: false; error: "captured"; receiptId: string; replay: true; currentStatus: AwaitingRateReceiptStatus }
  | { ok: false; error: "submissionPayloadMismatch" };

/** See `purchasePackageWithSubmissionIdentity`'s own doc comment — the identical contract, composed around
 * `prepayMonthlyObligationsInTx` instead. */
export async function prepayMonthlyObligationsWithSubmissionIdentity(
  args: {
    context: TenantContext;
    studentId: string;
    requestedMonths: YearMonth[];
    existingObligationIds?: string[];
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    maxBackdateDays: number;
    submissionId: string;
  },
  deps: LedgerDeps = {},
): Promise<PrepayMonthlyObligationsWithSubmissionIdentityResult> {
  const { context, studentId, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays, submissionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };
  if (context.organizationRole !== "ADMIN") return { ok: false, error: "notFound" };

  if (typeof studentId !== "string" || studentId === "") return { ok: false, error: "invalid" };
  if (typeof submissionId !== "string" || submissionId.trim() === "") return { ok: false, error: "invalid" };
  if (!Array.isArray(requestedMonths) || requestedMonths.length === 0 || !requestedMonths.every(isValidCoverageMonth)) return { ok: false, error: "invalid" };
  if (
    existingObligationIds !== undefined &&
    (!Array.isArray(existingObligationIds) || existingObligationIds.some((id) => typeof id !== "string" || id === ""))
  ) {
    return { ok: false, error: "invalid" };
  }
  if (!receivedOn || !isRealDate(receivedOn)) return { ok: false, error: "invalid" };
  if (!(CURRENCIES as readonly string[]).includes(tender?.currency)) return { ok: false, error: "invalid" };
  const parsedAmount = parseMoney(tender?.amount, { allowZero: false });
  if (!parsedAmount.ok) return { ok: false, error: "invalid" };
  if (!(Object.values(PaymentMethod) as string[]).includes(method)) return { ok: false, error: "invalid" };
  if (notes !== undefined && (typeof notes !== "string" || notes.length > PREPAY_MAX_NOTES)) return { ok: false, error: "invalid" };
  if (!Number.isInteger(maxBackdateDays) || maxBackdateDays < 0 || maxBackdateDays > PREPAY_MAX_BACKDATE_DAYS) return { ok: false, error: "invalid" };

  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, error: "notFound" };

  // The same consecutive-months check `prepayMonthlyObligations`'s own public wrapper runs before its transaction
  // opens — repeated here for this wrapper's own identical pre-transaction validation; `prepayMonthlyObligationsInTx`
  // re-checks it again internally regardless (trusts nothing from any caller).
  const sorted = [...requestedMonths].sort((a, b) => a.year - b.year || a.month - b.month);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const expectedNext = prev.month === 12 ? { year: prev.year + 1, month: 1 } : { year: prev.year, month: prev.month + 1 };
    if (!sameYearMonth(expectedNext, next)) return { ok: false, error: "coverageGap" };
  }

  const canonical = canonicalizePrepaymentSubmission({ studentId, requestedMonths, existingObligationIds, receivedOn, tender, method, notes });

  try {
    return await prisma.$transaction(async (tx): Promise<PrepayMonthlyObligationsWithSubmissionIdentityResult> => {
      await lockExchangeRateNamespaceShared(tx, organizationId);
      if (deps.afterExchangeRateLockForTest) await deps.afterExchangeRateLockForTest();

      const newId = crypto.randomUUID();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "DuesPaymentAttempt" ("id", "organizationId", "studentId", "academyId", "submissionId", "canonicalPayload")
        VALUES (${newId}, ${organizationId}, ${student.id}, ${student.homeAcademyId}, ${submissionId}, ${JSON.stringify(canonical)}::jsonb)
        ON CONFLICT ("organizationId", "submissionId") DO NOTHING
        RETURNING "id"
      `;
      if (deps.afterSubmissionIdentityInsertForTest) await deps.afterSubmissionIdentityInsertForTest(tx);

      if (inserted.length > 0) {
        const attemptId = inserted[0].id;
        const result = await prepayMonthlyObligationsInTx(tx, { context, student, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays }, deps);
        if (result.ok) {
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { paymentId: result.paymentId } });
          return result;
        }
        if (result.error === "captured") {
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { receiptId: result.receiptId } });
          return result;
        }
        throw new PrepaymentSubmissionRefusedError(result);
      }

      const existing = await tx.duesPaymentAttempt.findFirst({
        where: { organizationId, submissionId },
        select: { canonicalPayload: true, paymentId: true, receiptId: true },
      });
      if (!existing) {
        throw new Error(`DuesPaymentAttempt insert conflicted for submission ${submissionId} but no row was found immediately after — impossible under ON CONFLICT DO NOTHING`);
      }
      const parsedExisting = prepaymentCanonicalPayloadSchema.safeParse(existing.canonicalPayload);
      if (!parsedExisting.success || !prepaymentPayloadsEqual(parsedExisting.data, canonical)) {
        return { ok: false, error: "submissionPayloadMismatch" };
      }
      if (existing.paymentId) {
        const currentlyReversed = await readPaymentReversalStatus(tx, organizationId, existing.paymentId);
        return { ok: true, paymentId: existing.paymentId, replay: true, currentlyReversed };
      }
      if (existing.receiptId) {
        const currentStatus = await readReceiptStatus(tx, organizationId, existing.receiptId);
        return { ok: false, error: "captured", receiptId: existing.receiptId, replay: true, currentStatus };
      }
      throw new Error(`DuesPaymentAttempt row for submission ${submissionId} (organization ${organizationId}) has neither paymentId nor receiptId set`);
    });
  } catch (error) {
    if (error instanceof PrepaymentSubmissionRefusedError) return error.result;
    if (error instanceof PrepaymentRefusedError) return error.result;
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as PrepayMonthlyObligationsWithSubmissionIdentityResult;
    throw error;
  }
}
