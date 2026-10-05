import { z } from "zod";
import type { PaymentMethod, Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { resolveActionContext } from "@/lib/tenant/context";
import { parseMoney } from "@/lib/dues/config-input";
import type { CalendarDate } from "@/lib/dues/calendar";
import { inTenantScope } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { lockExchangeRateNamespaceShared } from "@/lib/dues/ledger/exchange-rate";
import { captureAwaitingRateReceiptInTx } from "@/lib/dues/ledger/awaiting-rate-receipt";
import {
  classifyRecordPaymentError,
  recordDuesPaymentInTx,
  validatePaymentInput,
  type RecordDuesPaymentError,
  type RecordDuesPaymentResult,
} from "@/lib/dues/ledger/record-payment";

/**
 * Payment-submission-identity prerequisite: idempotent retry safety for an ordinary payment submission, across all
 * three outcomes it can have (genuine success, capture with no rate available, or genuine refusal). Built entirely
 * AROUND `recordDuesPayment`'s own identical internal composition (`lockExchangeRateNamespaceShared` ->
 * `recordDuesPaymentInTx` -> conditionally `captureAwaitingRateReceiptInTx`) — `recordDuesPayment` itself is never
 * called, imported for its side effects, or modified by this file; it, and its own full existing test suite, are
 * completely unaffected by this module's existence. A plain library function: no `"use server"`, no route, no action,
 * no scheduler entry, closed by default (`activation.ts`) exactly like every other ledger writer.
 *
 * `submissionId` is REQUIRED — never optional, never generated here. Minting one server-side would defeat the entire
 * point of a client-supplied retry key: the caller must present the SAME key on every resend of what it considers one
 * logical submission for this to protect anything.
 */

const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The canonicalized request a `submissionId` is first associated with (brief §2). `maxBackdateDays` is deliberately
 * excluded — a server-resolved policy value, never part of the client's own request identity. */
const canonicalPaymentPayloadSchema = z.object({
  studentId: z.string().min(1),
  obligationIds: z.array(z.string().min(1)),
  receivedOn: z.string().min(1),
  tenderCurrency: z.string().min(1),
  tenderAmount: z.string().min(1),
  method: z.string().min(1),
  notes: z.string(),
});
type CanonicalPaymentPayload = z.infer<typeof canonicalPaymentPayloadSchema>;

/** Assumes `tender.amount` already passed `validatePaymentInput`'s own `parseMoney` check (every caller below calls it
 * first) — this never has to handle a malformed amount itself. `obligationIds` is sorted: their order is meaningful to
 * `recordDuesPaymentInTx`'s own oldest-first validation, but not to "is this the same logical submission". */
function canonicalizeSubmission(args: {
  studentId: string;
  obligationIds: string[];
  receivedOn: CalendarDate;
  tender: { currency: Currency; amount: string };
  method: PaymentMethod;
  notes?: string;
}): CanonicalPaymentPayload {
  const parsedAmount = parseMoney(args.tender.amount, { allowZero: false });
  if (!parsedAmount.ok) {
    throw new Error(`canonicalizeSubmission called with an amount that failed validatePaymentInput: ${args.tender.amount}`);
  }
  return {
    studentId: args.studentId,
    obligationIds: [...args.obligationIds].sort(),
    receivedOn: ymd(args.receivedOn),
    tenderCurrency: args.tender.currency,
    tenderAmount: parsedAmount.value,
    method: args.method,
    notes: args.notes && args.notes.trim() !== "" ? args.notes.trim() : "",
  };
}

/** Field-by-field, never a raw JSON string/structural compare: Postgres's own jsonb storage does not preserve the key
 * order a freshly-built JS object has, so comparing serialized text (or object identity) would produce false
 * mismatches for byte-identical resubmissions. */
function canonicalPayloadsEqual(a: CanonicalPaymentPayload, b: CanonicalPaymentPayload): boolean {
  return (
    a.studentId === b.studentId &&
    a.receivedOn === b.receivedOn &&
    a.tenderCurrency === b.tenderCurrency &&
    a.tenderAmount === b.tenderAmount &&
    a.method === b.method &&
    a.notes === b.notes &&
    a.obligationIds.length === b.obligationIds.length &&
    a.obligationIds.every((id, i) => id === b.obligationIds[i])
  );
}

/** Tags a mid-transaction refusal so it can be thrown — forcing Prisma to roll back the `DuesPaymentAttempt` insert
 * already written in this same transaction — and converted back to a plain result only after that rollback. Mirrors
 * `awaiting-rate-receipt.ts`'s own `ResolutionRefusedError` exactly. Never used for `rateUnavailable` (captured, not
 * thrown — a committed outcome) or `ok: true` (also committed). */
class SubmissionRefusedError extends Error {
  constructor(public readonly result: RecordDuesPaymentResult & { ok: false }) {
    super(`payment-submission-identity: refused mid-transaction (${result.error})`);
  }
}

export type RecordDuesPaymentWithSubmissionIdentityResult =
  | { ok: true; paymentId: string; settlementIds: string[]; feeIds: string[]; totalMinor: number }
  /** A replay of an already-settled submission: the original outcome, not re-derived settlement detail. Call
   * `getSubmissionOutcome` for the payment's current lifecycle state (e.g. whether it has since been reversed). */
  | { ok: true; paymentId: string; replay: true }
  | (RecordDuesPaymentResult & { ok: false })
  /** The same `submissionId` was already used for a materially different request — refused cleanly; nothing is
   * written by this call. */
  | { ok: false; error: "submissionPayloadMismatch" };

const refuse = (error: RecordDuesPaymentError): RecordDuesPaymentWithSubmissionIdentityResult => ({ ok: false, error });

/**
 * Record ONE payment, idempotently keyed by the caller's own `submissionId`. Takes everything `recordDuesPayment`
 * takes, plus a required `submissionId`. A resend of the identical request (same `submissionId`, same canonicalized
 * payload) is always safe: it never re-settles, never double-captures, and never double-refuses — it replays the
 * original outcome, re-read fresh for its own CURRENT lifecycle state (`getSubmissionOutcome`'s own job, not this
 * function's). A resend of a DIFFERENT request under the same `submissionId` is refused (`submissionPayloadMismatch`)
 * and writes nothing.
 *
 * LOCK ORDER: the identity insert sits AFTER `lockExchangeRateNamespaceShared` (the literal first statement, exactly
 * like `recordDuesPayment`'s own) and BEFORE the student lock `recordDuesPaymentInTx` itself takes — a losing/replay
 * request never reaches the student lock at all, and two genuinely concurrent submissions for the SAME `submissionId`
 * serialize on the identity row's own unique index, not on the student row.
 */
export async function recordDuesPaymentWithSubmissionIdentity(
  args: {
    context: TenantContext;
    studentId: string;
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    obligationIds: string[];
    notes?: string;
    maxBackdateDays: number;
    submissionId: string;
  },
  deps: LedgerDeps = {},
): Promise<RecordDuesPaymentWithSubmissionIdentityResult> {
  const { context, studentId, receivedOn, tender, method, obligationIds, notes, maxBackdateDays, submissionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");

  if (typeof studentId !== "string" || studentId === "") return refuse("invalid");
  if (typeof submissionId !== "string" || submissionId === "") return refuse("invalid");
  const inputError = validatePaymentInput({ receivedOn, tender, method, obligationIds, notes, maxBackdateDays });
  if (inputError) return refuse(inputError);

  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  const canonical = canonicalizeSubmission({ studentId, obligationIds, receivedOn, tender, method, notes });

  try {
    return await prisma.$transaction(async (tx): Promise<RecordDuesPaymentWithSubmissionIdentityResult> => {
      // The literal first statement, SHARED — identical to recordDuesPayment's own.
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
        // Won: a genuinely new submission. Compose recordDuesPaymentInTx exactly as recordDuesPayment itself does,
        // completely unmodified — the student lock it takes is the first row lock this transaction acquires.
        const attemptId = inserted[0].id;
        const result = await recordDuesPaymentInTx(tx, { context, student, receivedOn, tender, method, obligationIds, notes, maxBackdateDays }, deps);
        if (result.ok) {
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { paymentId: result.paymentId } });
          return result;
        }
        if (result.error === "rateUnavailable") {
          const capturedAt = (deps.now ?? (() => new Date()))();
          const captured = await captureAwaitingRateReceiptInTx(tx, {
            context,
            student,
            kind: "ORDINARY",
            receivedOn,
            tenderCurrency: tender.currency,
            tenderAmount: canonical.tenderAmount,
            method,
            notes,
            snapshot: { kind: "ORDINARY", obligationIds },
            capturedAt,
          });
          await tx.duesPaymentAttempt.update({ where: { id: attemptId, organizationId }, data: { receiptId: captured.receiptId } });
          return captured;
        }
        // Every other refusal: nothing else written in this transaction besides the attempt row above, which must
        // roll back too — a genuine refusal leaves zero DuesPaymentAttempt rows, so the same submissionId is
        // genuinely fresh again afterward.
        throw new SubmissionRefusedError(result);
      }

      // Lost: read the winner's (or an earlier genuine attempt's) row.
      const existing = await tx.duesPaymentAttempt.findFirst({
        where: { organizationId, submissionId },
        select: { canonicalPayload: true, paymentId: true, receiptId: true },
      });
      if (!existing) {
        throw new Error(`DuesPaymentAttempt insert conflicted for submission ${submissionId} but no row was found immediately after — impossible under ON CONFLICT DO NOTHING`);
      }
      const parsedExisting = canonicalPaymentPayloadSchema.safeParse(existing.canonicalPayload);
      if (!parsedExisting.success || !canonicalPayloadsEqual(parsedExisting.data, canonical)) {
        return { ok: false, error: "submissionPayloadMismatch" };
      }
      if (existing.paymentId) return { ok: true, paymentId: existing.paymentId, replay: true };
      if (existing.receiptId) return { ok: false, error: "captured", receiptId: existing.receiptId };
      // A committed row with neither field set cannot legitimately be observed: the writer that inserted it either
      // commits with one of them set, or throws and rolls back the whole insert. Seeing this is a bug, not a case to
      // handle gracefully.
      throw new Error(`DuesPaymentAttempt row for submission ${submissionId} (organization ${organizationId}) has neither paymentId nor receiptId set`);
    });
  } catch (error) {
    if (error instanceof SubmissionRefusedError) return error.result; // AFTER rollback, never before
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified;
    throw error;
  }
}

export type SubmissionOutcome =
  | { status: "notFound" }
  | {
      status: "committed";
      outcome:
        | { kind: "payment"; paymentId: string; currentlyReversed: boolean }
        | { kind: "receipt"; receiptId: string; currentStatus: "PENDING" | "RESOLVED" | "CANCELLED" };
    };

/**
 * The authorized, read-only counterpart to `recordDuesPaymentWithSubmissionIdentity`: resolves a `submissionId` to
 * its CURRENT lifecycle state, re-read fresh — never cached or assumed from the moment of original commit (a replayed
 * receipt since resolved or cancelled, or a replayed payment since reversed, must never be reported as if it were
 * still in its original state).
 *
 * THREE DISTINCT AUTHORIZATION OUTCOMES, deliberately never collapsed into each other:
 *  - No session, a non-member, or an inactive organization (`resolveActionContext` returns `{ ok: false }`): resolves
 *    to `{ status: "notFound" }` — the same "disclose to members, never to non-members" rule every other cross-org
 *    check in this codebase already applies.
 *  - A genuine member whose role is neither ADMIN nor DIRECTOR: `resolveActionContext` THROWS (its own uncaught
 *    `Error("FORBIDDEN")`) — deliberately NOT caught here, so it propagates. This is an ordinary authorization
 *    failure on a real member of the right organization, not the cross-organization disclosure case above.
 *  - A genuine ADMIN or DIRECTOR of a DIFFERENT branch than the attempt's own `academyId`: `resolveActionContext`
 *    SUCCEEDS (the role check passed) and the SEPARATE branch-scope check below fails — resolves to
 *    `{ status: "notFound" }`, not a thrown error. A successful role check followed by a failed scope check must
 *    never be conflated with the thrown wrong-role case above.
 *
 * `inTenantScope` takes a branch/academy id, never a student id — the attempt's own denormalized `academyId` is
 * passed directly, never `studentId`.
 */
export async function getSubmissionOutcome(organizationId: string, submissionId: string): Promise<SubmissionOutcome> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { status: "notFound" };
  const context = auth.context;

  if (typeof submissionId !== "string" || submissionId === "") return { status: "notFound" };

  const attempt = await prisma.duesPaymentAttempt.findFirst({
    where: { organizationId, submissionId },
    select: { academyId: true, paymentId: true, receiptId: true },
  });
  if (!attempt || !inTenantScope(context, attempt.academyId)) return { status: "notFound" };

  if (attempt.paymentId) {
    const payment = await prisma.duesPayment.findFirst({ where: { id: attempt.paymentId, organizationId }, select: { reversedAt: true } });
    if (!payment) throw new Error(`getSubmissionOutcome: attempt for submission ${submissionId} references paymentId ${attempt.paymentId}, which no longer resolves`);
    return { status: "committed", outcome: { kind: "payment", paymentId: attempt.paymentId, currentlyReversed: payment.reversedAt !== null } };
  }
  if (attempt.receiptId) {
    const receipt = await prisma.awaitingRateReceipt.findFirst({ where: { id: attempt.receiptId, organizationId }, select: { status: true } });
    if (!receipt) throw new Error(`getSubmissionOutcome: attempt for submission ${submissionId} references receiptId ${attempt.receiptId}, which no longer resolves`);
    return { status: "committed", outcome: { kind: "receipt", receiptId: attempt.receiptId, currentStatus: receipt.status } };
  }
  throw new Error(`getSubmissionOutcome: attempt for submission ${submissionId} (organization ${organizationId}) has neither paymentId nor receiptId set`);
}
