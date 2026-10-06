import { z } from "zod";
import type { PaymentMethod, Currency, AwaitingRateReceiptStatus } from "@/generated/prisma/client";
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
 *
 * The separate-wrapper approach (this file, never restructuring `recordDuesPayment` in place) is a DELIBERATE
 * compatibility choice, not an oversight or a scaled-back version of an earlier design that called for modifying
 * `recordDuesPayment` itself: every existing caller and test of `recordDuesPayment` keeps working, byte-for-byte,
 * whether or not a future caller ever adopts this identity-aware sibling.
 */

const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The canonicalized request a `submissionId` is first associated with (brief §2). `maxBackdateDays` is deliberately
 * excluded — a server-resolved policy value, never part of the client's own request identity. */
/** Prepayment/package-purchase UI brief §2.6: `operation` defaults to `"ORDINARY"` so an already-committed row from
 * BEFORE this field existed (every `DuesPaymentAttempt` written by this already-merged PR) still parses and
 * replays correctly — never a backfill, never a rewrite of an immutable row (`dues_set_once_marker`), purely a
 * read/parse-side accommodation. `canonicalizeSubmission` below now emits this explicitly for every fresh ordinary
 * request, so a legacy row's defaulted value and a fresh request's own explicit value compare equal. */
export const canonicalPaymentPayloadSchema = z.object({
  operation: z.enum(["ORDINARY", "PACKAGE", "PREPAYMENT"]).default("ORDINARY"),
  studentId: z.string().min(1),
  obligationIds: z.array(z.string().min(1)),
  receivedOn: z.string().min(1),
  tenderCurrency: z.string().min(1),
  tenderAmount: z.string().min(1),
  method: z.string().min(1),
  notes: z.string(),
});
export type CanonicalPaymentPayload = z.infer<typeof canonicalPaymentPayloadSchema>;

/** The `operation` discriminator alone, extracted from ANY writer's stored `canonicalPayload` without knowing in
 * advance which writer's own full schema to validate against — used only by `getSubmissionOutcome`'s own generic
 * operation gate below (brief §2.6 point 1), never by a writer's own payload-comparison (which always uses its own
 * specific schema directly — the package/prepayment writers' own disjoint field shapes already make a foreign
 * payload fail THEIR OWN schema naturally, with `operation` compared explicitly too as a second, independent
 * layer of protection, never relying on shape alone).
 *
 * MUST FAIL CLOSED, never open: an explicit, valid `operation` field is trusted directly; failing that, the legacy
 * `"ORDINARY"` default is granted ONLY after the payload is independently confirmed to genuinely be a valid legacy
 * ordinary payload (reusing `canonicalPaymentPayloadSchema` itself, whose own `.default("ORDINARY")` is exactly
 * what lets a key-absent-but-otherwise-valid payload parse as that). Anything else — a non-object, an invalid
 * `operation` value, or a payload that fails the full ordinary schema on some OTHER field — resolves `"UNKNOWN"`,
 * never `"ORDINARY"`. `getSubmissionOutcome`'s own gate (`!== "ORDINARY" && role !== "ADMIN"` -> notFound) already
 * treats `"UNKNOWN"` as non-ORDINARY with no further change: an unclassifiable row is never disclosed to a
 * DIRECTOR, matching the same non-disclosure shape as a genuine PACKAGE/PREPAYMENT row. */
const operationFieldSchema = z.object({ operation: z.enum(["ORDINARY", "PACKAGE", "PREPAYMENT"]) }).passthrough();
export function readStoredOperation(canonicalPayload: unknown): "ORDINARY" | "PACKAGE" | "PREPAYMENT" | "UNKNOWN" {
  const explicit = operationFieldSchema.safeParse(canonicalPayload);
  if (explicit.success) return explicit.data.operation;
  const asLegacyOrdinary = canonicalPaymentPayloadSchema.safeParse(canonicalPayload);
  if (asLegacyOrdinary.success && asLegacyOrdinary.data.operation === "ORDINARY") return "ORDINARY";
  return "UNKNOWN";
}

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
    operation: "ORDINARY",
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
    // Prepayment/package-purchase UI brief §2.6: compared explicitly, never left to incidental shape differences
    // alone — a cross-writer submissionId collision (astronomically unlikely with crypto.randomUUID(), but not
    // assumed away) must never compare equal just because every OTHER field happened to coincide.
    a.operation === b.operation &&
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

/** The minimal shape both the plain `prisma` singleton and an open transaction (`Tx`) satisfy — just enough for the
 * two lookups below, so neither helper needs to know which one it was called with. Exported for reuse by the
 * package/prepayment identity wrappers (brief §2.6) — these two lookups are entirely generic (payment/receipt
 * lifecycle, not writer-specific), the same reasoning that already applies within this file. */
export type OutcomeReadClient = {
  duesPayment: { findFirst(args: { where: { id: string; organizationId: string }; select: { reversedAt: true } }): Promise<{ reversedAt: Date | null } | null> };
  awaitingRateReceipt: { findFirst(args: { where: { id: string; organizationId: string }; select: { status: true } }): Promise<{ status: AwaitingRateReceiptStatus } | null> };
};

/** Shared by the writer's own replay branch (via the open `tx`, a consistent snapshot with no second round-trip) and
 * `getSubmissionOutcome` (via the plain `prisma` client) — one lookup, never duplicated. Deliberately takes no
 * `TenantContext`/auth of any kind: this is the ledger engine layer, which never calls `resolveActionContext` itself
 * anywhere in this codebase: authorization is each caller's own job. */
export async function readPaymentReversalStatus(client: OutcomeReadClient, organizationId: string, paymentId: string): Promise<boolean> {
  const payment = await client.duesPayment.findFirst({ where: { id: paymentId, organizationId }, select: { reversedAt: true } });
  if (!payment) throw new Error(`readPaymentReversalStatus: paymentId ${paymentId} no longer resolves (organization ${organizationId})`);
  return payment.reversedAt !== null;
}

/** See `readPaymentReversalStatus`'s own doc comment — the identical sharing for a receipt outcome's current status. */
export async function readReceiptStatus(client: OutcomeReadClient, organizationId: string, receiptId: string): Promise<AwaitingRateReceiptStatus> {
  const receipt = await client.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { status: true } });
  if (!receipt) throw new Error(`readReceiptStatus: receiptId ${receiptId} no longer resolves (organization ${organizationId})`);
  return receipt.status;
}

export type RecordDuesPaymentWithSubmissionIdentityResult =
  | { ok: true; paymentId: string; settlementIds: string[]; feeIds: string[]; totalMinor: number }
  /** A replay of an already-settled submission, carrying the payment's CURRENT lifecycle state (read fresh in the
   * same transaction, never cached from the moment of original commit) — never just the bare original outcome. */
  | { ok: true; paymentId: string; replay: true; currentlyReversed: boolean }
  | (RecordDuesPaymentResult & { ok: false })
  /** A replay of an already-captured submission, carrying the receipt's CURRENT status the same way. */
  | { ok: false; error: "captured"; receiptId: string; replay: true; currentStatus: AwaitingRateReceiptStatus }
  /** The same `submissionId` was already used for a materially different request — refused cleanly; nothing is
   * written by this call. */
  | { ok: false; error: "submissionPayloadMismatch" };

const refuse = (error: RecordDuesPaymentError): RecordDuesPaymentWithSubmissionIdentityResult => ({ ok: false, error });

/**
 * Record ONE payment, idempotently keyed by the caller's own `submissionId`. Takes everything `recordDuesPayment`
 * takes, plus a required `submissionId`. A resend of the identical request (same `submissionId`, same canonicalized
 * payload) is always safe: it never re-settles, never double-captures, and never double-refuses — it replays the
 * original outcome, carrying that outcome's own CURRENT lifecycle state (read fresh in this same transaction, never
 * assumed from the moment of original commit — `getSubmissionOutcome` reuses the identical lookup for a later,
 * out-of-band check). A resend of a DIFFERENT request under the same `submissionId` is refused
 * (`submissionPayloadMismatch`) and writes nothing.
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
  if (typeof submissionId !== "string" || submissionId.trim() === "") return refuse("invalid");
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
      if (existing.paymentId) {
        const currentlyReversed = await readPaymentReversalStatus(tx, organizationId, existing.paymentId);
        return { ok: true, paymentId: existing.paymentId, replay: true, currentlyReversed };
      }
      if (existing.receiptId) {
        const currentStatus = await readReceiptStatus(tx, organizationId, existing.receiptId);
        return { ok: false, error: "captured", receiptId: existing.receiptId, replay: true, currentStatus };
      }
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
        | { kind: "receipt"; receiptId: string; currentStatus: AwaitingRateReceiptStatus };
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
    select: { academyId: true, paymentId: true, receiptId: true, canonicalPayload: true },
  });
  if (!attempt || !inTenantScope(context, attempt.academyId)) return { status: "notFound" };

  // Prepayment/package-purchase UI brief §2.6 point 1: a genuine DIRECTOR (admitted by the role check above, for
  // ordinary payments) must never retrieve a package/prepayment outcome through this SAME, single, existing
  // endpoint — there is no second, separately-gated endpoint to lock down instead. Resolved to `notFound` (never
  // thrown), the same non-disclosure shape the out-of-branch-scope case above already uses, now extended to
  // operation scope as well as branch scope — checked only AFTER the row is found, since role alone cannot decide
  // this before the row's own `operation` is known.
  if (readStoredOperation(attempt.canonicalPayload) !== "ORDINARY" && context.organizationRole !== "ADMIN") {
    return { status: "notFound" };
  }

  if (attempt.paymentId) {
    const currentlyReversed = await readPaymentReversalStatus(prisma, organizationId, attempt.paymentId);
    return { status: "committed", outcome: { kind: "payment", paymentId: attempt.paymentId, currentlyReversed } };
  }
  if (attempt.receiptId) {
    const currentStatus = await readReceiptStatus(prisma, organizationId, attempt.receiptId);
    return { status: "committed", outcome: { kind: "receipt", receiptId: attempt.receiptId, currentStatus } };
  }
  throw new Error(`getSubmissionOutcome: attempt for submission ${submissionId} (organization ${organizationId}) has neither paymentId nor receiptId set`);
}
