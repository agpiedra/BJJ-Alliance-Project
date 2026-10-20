import { randomUUID } from "node:crypto";
import { Prisma, type Currency, type DuesReadinessConfirmationKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { lockStudent, type Tx } from "@/lib/students/lock";
import { lockBranchShared } from "@/lib/dues/ledger/common";
import { assertYearMonth, compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, parseEffectiveMonth, parseMoney } from "@/lib/dues/config-input";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { ActionState } from "@/lib/action-state";
import type { TenantContext } from "@/lib/tenant/types";
import { FINGERPRINT_FORMAT, branchFingerprint, openingReviewBinding, pricingAckBinding, studentFingerprint } from "@/lib/dues/readiness/fingerprint";
import type { ReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Stage 8 PR 8c (docs/dues/STAGE-8C-IMPLEMENTATION-PLAN.md, revision 2): the cores of the five owner actions over opening-debt
 * drafts and readiness confirmations.
 *
 * Deliberately NOT a "use server" file (the `assignment-core.ts` precedent): every function here trusts an already-authorized
 * `TenantContext` and performs no authentication of its own, so none may ever be client-invocable. `opening-actions.ts` is the
 * only public surface.
 *
 * Every write runs in ONE READ COMMITTED transaction on ONE pooled connection, in the ledger's lock order (branch `FOR SHARE`,
 * then student `FOR UPDATE`), and writes its `AuditLog` row inside the same transaction. Nothing here asks the pool for a second
 * connection while a transaction is open: a confirmation's content read is a single statement on the transaction's own
 * connection (`loadReviewContentInTx`), never a nested snapshot.
 *
 * `TestHooks` are TEST-ONLY pause points (the `LedgerDeps.beforeLateFeeInsert` / `afterFirstRead` convention). The public
 * actions never pass them.
 */
export type TestHooks = {
  /** Inside the transaction, right after both locks are held. */
  afterLocks?: (tx: Tx) => Promise<void>;
  /** Confirmations only: after the single-statement content read, before the sequence read and insert. */
  afterContentRead?: (tx: Tx) => Promise<void>;
  /** After the change, before its audit row. */
  beforeAudit?: (tx: Tx) => Promise<void>;
  /** After the audit row, still inside the transaction. */
  afterAudit?: (tx: Tx) => Promise<void>;
  /** The clock for the "not after the current month" rule. */
  now?: () => Date;
};

export type DraftContent = {
  coverageYear: number;
  coverageMonth: number;
  amount: string;
  currency: Currency;
  note: string;
  legacyPaymentPeriodId: string | null;
};

type Read = (name: string) => string | null;
type Rejection = { rejected: ActionState };
const reject = (state: ActionState): Rejection => ({ rejected: state });
const isRejection = (value: unknown): value is Rejection => typeof value === "object" && value !== null && "rejected" in value;
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** Text of 1-500 characters after trimming, counted in code points exactly as the CHECK's `char_length` counts them. */
function boundedText(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= 500 ? trimmed : null;
}

/** A draft's content from the form. `null` legacy link when the field is absent or blank. */
export function parseDraftContent(read: Read): { ok: true; value: DraftContent } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const month = parseEffectiveMonth(read("coverageYear"), read("coverageMonth"));
  if (!month.ok) fieldErrors.coverageMonth = ["invalid"];
  const amount = parseMoney(read("amount"), { allowZero: false });
  if (!amount.ok) fieldErrors.amount = ["invalid"];
  const currencyRaw = read("currency");
  const currency = currencyRaw !== null && (CURRENCIES as readonly string[]).includes(currencyRaw) ? (currencyRaw as Currency) : null;
  if (!currency) fieldErrors.currency = ["invalid"];
  const note = boundedText(read("note"));
  if (note === null) fieldErrors.note = ["invalid"];
  const linkRaw = read("legacyPaymentPeriodId");
  if (!month.ok || !amount.ok || !currency || note === null) return { ok: false, fieldErrors };
  return {
    ok: true,
    value: {
      coverageYear: month.value.year,
      coverageMonth: month.value.month,
      amount: amount.value,
      currency,
      note,
      legacyPaymentPeriodId: linkRaw === null || linkRaw.trim() === "" ? null : linkRaw,
    },
  };
}

export const parseReason = boundedText;

/** A candidate start month: the same rule as the readiness report (`index.ts`), a calendar month in 2000-2100. */
export function parseCandidate(yearRaw: string | null, monthRaw: string | null): YearMonth | null {
  const parsed = parseEffectiveMonth(yearRaw, monthRaw);
  if (!parsed.ok) return null;
  try {
    assertYearMonth(parsed.value);
  } catch {
    return null;
  }
  return parsed.value;
}

const HASH = /^[0-9a-f]{64}$/;
export const parseBinding = (raw: string | null): string | null => (raw !== null && HASH.test(raw) ? raw : null);

/**
 * The legacy-payment link (plan §3.2). Not found in THIS organization (including another organization's row) is the uniform
 * `notFound`; this organization's own row for another student or month is a validation error that names nothing foreign.
 */
async function checkLegacyLink(organizationId: string, studentId: string, content: DraftContent): Promise<ActionState | null> {
  if (content.legacyPaymentPeriodId === null) return null;
  const row = await prisma.paymentPeriod.findFirst({
    where: { id: content.legacyPaymentPeriodId, organizationId },
    select: { studentId: true, year: true, month: true },
  });
  if (!row) return { error: "notFound" };
  if (row.studentId !== studentId || row.year !== content.coverageYear || row.month !== content.coverageMonth) {
    return { error: "invalid", fieldErrors: { legacyPaymentPeriodId: ["mismatch"] } };
  }
  return null;
}

async function findStudent(organizationId: string, studentId: string) {
  return prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
}

/**
 * One READ COMMITTED transaction holding the branch row `FOR SHARE` and the student row `FOR UPDATE`, in that order. The home
 * branch was read before the transaction (to know which branch to lock); if the locked student row names another branch, the
 * wrong branch is held, so the call is refused as `stale` rather than retried.
 *
 * `uniqueMeansMonthHasDraft`: for draft writes the only unique key an insert can hit is the one-active-per-month index (a
 * successor id is fresh), so P2002 maps to `monthHasDraft`. For confirmations a P2002 (the sequence key, reachable only by a
 * writer that skipped the lock) must never look like an ordinary outcome, so it propagates.
 */
async function underStudentLock(
  context: TenantContext,
  student: { id: string; homeAcademyId: string },
  hooks: TestHooks,
  uniqueMeansMonthHasDraft: boolean,
  body: (tx: Tx, timezone: string) => Promise<Rejection | null>,
): Promise<ActionState> {
  let outcome: Rejection | null;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const branch = await lockBranchShared(tx, context.organizationId, student.homeAcademyId);
        if (!branch) return reject({ error: "stale" });
        const locked = await lockStudent(tx, context.organizationId, student.id);
        if (!locked) return reject({ error: "notFound" });
        if (locked.homeAcademyId !== student.homeAcademyId) return reject({ error: "stale" });
        await hooks.afterLocks?.(tx);
        return body(tx, branch.timezone);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    if (uniqueMeansMonthHasDraft && isUniqueViolation(error)) return { error: "monthHasDraft" };
    throw error;
  }
  return outcome ? outcome.rejected : { ok: true };
}

const futureMonth = (content: DraftContent, timezone: string, hooks: TestHooks) =>
  compareYearMonth({ year: content.coverageYear, month: content.coverageMonth }, currentMonthIn(timezone, hooks.now?.() ?? new Date())) > 0;
const FUTURE = reject({ error: "invalid", fieldErrors: { coverageMonth: ["future"] } });

const contentForAudit = (c: DraftContent) => ({
  coverageYear: c.coverageYear,
  coverageMonth: c.coverageMonth,
  amount: c.amount,
  currency: c.currency,
  note: c.note,
  legacyPaymentPeriodId: c.legacyPaymentPeriodId,
});

export async function createOpeningDraftCore(context: TenantContext, studentId: string, content: DraftContent, hooks: TestHooks = {}): Promise<ActionState> {
  const student = await findStudent(context.organizationId, studentId);
  if (!student) return { error: "notFound" };
  const link = await checkLegacyLink(context.organizationId, student.id, content);
  if (link) return link;

  return underStudentLock(context, student, hooks, true, async (tx, timezone) => {
    if (futureMonth(content, timezone, hooks)) return FUTURE;
    const created = await tx.duesOpeningItem.create({
      data: { organizationId: context.organizationId, studentId: student.id, ...content, createdById: context.actorUserId },
    });
    await hooks.beforeAudit?.(tx);
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: student.homeAcademyId,
        action: "duesOpeningItem.create",
        entityType: "DuesOpeningItem",
        entityId: created.id,
        before: Prisma.DbNull,
        after: { studentId: student.id, ...contentForAudit(content) },
      },
    });
    await hooks.afterAudit?.(tx);
    return null;
  });
}

async function findDraft(organizationId: string, draftId: string) {
  return prisma.duesOpeningItem.findFirst({
    where: { id: draftId, organizationId },
    select: { id: true, student: { select: { id: true, homeAcademyId: true } } },
  });
}

/** The draft re-read under the student lock; only an ACTIVE draft can be replaced or withdrawn, so this rejects every stale edit. */
async function lockedActiveDraft(tx: Tx, organizationId: string, draftId: string) {
  const row = await tx.duesOpeningItem.findFirst({ where: { id: draftId, organizationId } });
  if (!row) return reject({ error: "notFound" });
  if (row.withdrawnAt !== null) return reject({ error: "stale" });
  return row;
}

const rowContent = (row: { coverageYear: number; coverageMonth: number; amount: { toFixed(d: number): string }; currency: Currency; note: string; legacyPaymentPeriodId: string | null }) =>
  contentForAudit({ ...row, amount: row.amount.toFixed(2) });

/** Plan §3.3: the predecessor's marker FIRST (naming a pre-generated successor id), THEN the successor; the deferred FK checks at commit. */
export async function replaceOpeningDraftCore(context: TenantContext, draftId: string, content: DraftContent, hooks: TestHooks = {}): Promise<ActionState> {
  const found = await findDraft(context.organizationId, draftId);
  if (!found) return { error: "notFound" };
  const student = found.student;
  const link = await checkLegacyLink(context.organizationId, student.id, content);
  if (link) return link;

  return underStudentLock(context, student, hooks, true, async (tx, timezone) => {
    const old = await lockedActiveDraft(tx, context.organizationId, found.id);
    if (isRejection(old)) return old;
    if (futureMonth(content, timezone, hooks)) return FUTURE;
    const successorId = randomUUID();
    await tx.duesOpeningItem.update({
      where: { id: old.id, organizationId: context.organizationId },
      data: { withdrawnAt: new Date(), withdrawnById: context.actorUserId, withdrawalKind: "EDITED", supersededById: successorId },
    });
    await tx.duesOpeningItem.create({
      data: { id: successorId, organizationId: context.organizationId, studentId: student.id, ...content, createdById: context.actorUserId },
    });
    await hooks.beforeAudit?.(tx);
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: student.homeAcademyId,
        action: "duesOpeningItem.replace",
        entityType: "DuesOpeningItem",
        entityId: old.id,
        before: rowContent(old),
        after: { successorId, ...contentForAudit(content) },
      },
    });
    await hooks.afterAudit?.(tx);
    return null;
  });
}

export async function withdrawOpeningDraftCore(context: TenantContext, draftId: string, reason: string, hooks: TestHooks = {}): Promise<ActionState> {
  const found = await findDraft(context.organizationId, draftId);
  if (!found) return { error: "notFound" };

  return underStudentLock(context, found.student, hooks, true, async (tx) => {
    const old = await lockedActiveDraft(tx, context.organizationId, found.id);
    if (isRejection(old)) return old;
    await tx.duesOpeningItem.update({
      where: { id: old.id, organizationId: context.organizationId },
      data: { withdrawnAt: new Date(), withdrawnById: context.actorUserId, withdrawalKind: "WITHDRAWN", withdrawalReason: reason },
    });
    await hooks.beforeAudit?.(tx);
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: found.student.homeAcademyId,
        action: "duesOpeningItem.withdraw",
        entityType: "DuesOpeningItem",
        entityId: old.id,
        before: rowContent(old),
        after: { reason },
      },
    });
    await hooks.afterAudit?.(tx);
    return null;
  });
}

type ContentRow = {
  students: ReadinessSnapshot["students"];
  statusChanges: ReadinessSnapshot["statusChanges"];
  assignments: ReadinessSnapshot["assignments"];
  legacyPayments: ReadinessSnapshot["legacyPayments"];
  monthlyObligations: ReadinessSnapshot["monthlyObligations"];
  coverage: ReadinessSnapshot["coverage"];
  drafts: (ReadinessSnapshot["openingItems"][number] & { withdrawn: boolean; withdrawalKind: string | null; supersededById: string | null })[];
  branches: ReadinessSnapshot["branches"];
  policies: ReadinessSnapshot["policies"];
  plans: ReadinessSnapshot["plans"];
  terms: ReadinessSnapshot["terms"];
};

/**
 * Plan §4.2–§4.4: the reviewed content of ONE student and their home branch, read by ONE parameterized SQL statement on the
 * caller's own transaction connection. Under READ COMMITTED a statement has one snapshot, taken when it starts and shared by all
 * of its subqueries, so the content is internally consistent; issued after the branch and student locks, it includes every
 * participating writer's commit from before the lock grant. Writers that take neither lock (legacy payments, legacy plans,
 * branch timezone, future-assignment correction) are seen exactly as committed when the statement started — they are NOT
 * locked out by this; a later write by them makes the confirmation stale at the next report if it changes covered content.
 *
 * Every subquery is filtered by `organizationId`; every value is a bound parameter. Column formats match `loadReadinessSnapshot`
 * (amounts as `numeric(10,2)::text` = `Decimal.toFixed(2)`, dates as `YYYY-MM-DD`, enums as text), and the drafts are split the
 * way `snapshot.ts` splits them, so the unchanged fingerprint functions give the report's result for this student and branch —
 * proved field by field in tests/integration/dues-opening-actions.test.ts. A change of the covered fields (a new fingerprint
 * format) must change BOTH readers; that test fails otherwise.
 */
export async function loadReviewContentInTx(tx: Tx, organizationId: string, studentId: string, academyId: string): Promise<ReadinessSnapshot> {
  const [row] = await tx.$queryRaw<{ content: ContentRow }[]>`
    SELECT json_build_object(
      'students', COALESCE((SELECT json_agg(json_build_object('id', s."id", 'homeAcademyId', s."homeAcademyId", 'status', s."status"::text))
        FROM "Student" s WHERE s."organizationId" = ${organizationId} AND s."id" = ${studentId}), '[]'::json),
      'statusChanges', COALESCE((SELECT json_agg(json_build_object('id', r."id", 'studentId', r."studentId", 'status', r."status"::text,
          'effectiveOn', to_char(r."effectiveOn", 'YYYY-MM-DD'), 'sequence', r."sequence", 'source', r."source"::text))
        FROM "StudentStatusChange" r WHERE r."organizationId" = ${organizationId} AND r."studentId" = ${studentId}), '[]'::json),
      'assignments', COALESCE((SELECT json_agg(json_build_object('id', a."id", 'studentId', a."studentId", 'planId', a."planId",
          'effectiveYear', a."effectiveYear", 'effectiveMonth', a."effectiveMonth"))
        FROM "StudentPlanAssignment" a WHERE a."organizationId" = ${organizationId} AND a."studentId" = ${studentId}), '[]'::json),
      'legacyPayments', COALESCE((SELECT json_agg(json_build_object('id', p."id", 'studentId', p."studentId", 'year', p."year", 'month', p."month",
          'status', p."status"::text, 'amount', p."amount"::text, 'currency', p."currency"::text, 'planId', p."planId",
          'promoName', p."promoName", 'promoRecurring', p."promoRecurring"))
        FROM "PaymentPeriod" p WHERE p."organizationId" = ${organizationId} AND p."studentId" = ${studentId}), '[]'::json),
      'monthlyObligations', COALESCE((SELECT json_agg(json_build_object('id', o."id", 'studentId', o."studentId",
          'coverageYear', o."coverageYear", 'coverageMonth', o."coverageMonth"))
        FROM "DuesObligation" o WHERE o."organizationId" = ${organizationId} AND o."studentId" = ${studentId} AND o."type" = 'MONTHLY'), '[]'::json),
      'coverage', COALESCE((SELECT json_agg(json_build_object('id', c."id", 'studentId', c."studentId", 'year', c."year", 'month', c."month"))
        FROM "DuesCoverage" c WHERE c."organizationId" = ${organizationId} AND c."studentId" = ${studentId}), '[]'::json),
      'drafts', COALESCE((SELECT json_agg(json_build_object('id', d."id", 'studentId', d."studentId", 'coverageYear', d."coverageYear",
          'coverageMonth', d."coverageMonth", 'amount', d."amount"::text, 'currency', d."currency"::text, 'note', d."note",
          'legacyPaymentPeriodId', d."legacyPaymentPeriodId", 'withdrawn', d."withdrawnAt" IS NOT NULL,
          'withdrawalKind', d."withdrawalKind"::text, 'supersededById', d."supersededById"))
        FROM "DuesOpeningItem" d WHERE d."organizationId" = ${organizationId} AND d."studentId" = ${studentId}), '[]'::json),
      'branches', COALESCE((SELECT json_agg(json_build_object('id', b."id", 'timezone', b."timezone"))
        FROM "Academy" b WHERE b."organizationId" = ${organizationId} AND b."id" = ${academyId}), '[]'::json),
      'policies', COALESCE((SELECT json_agg(json_build_object('id', v."id", 'academyId', v."academyId", 'effectiveYear', v."effectiveYear",
          'effectiveMonth', v."effectiveMonth", 'dueDay', v."dueDay", 'graceDay', v."graceDay", 'lateFeeAmount', v."lateFeeAmount"::text,
          'lateFeeCurrency', v."lateFeeCurrency"::text, 'maxPrepaidMonths', v."maxPrepaidMonths"))
        FROM "DuesPolicyVersion" v WHERE v."organizationId" = ${organizationId} AND v."academyId" = ${academyId}), '[]'::json),
      'plans', COALESCE((SELECT json_agg(json_build_object('id', pl."id", 'academyId', pl."academyId", 'name', pl."name", 'active', pl."active"))
        FROM "PaymentPlan" pl WHERE pl."organizationId" = ${organizationId} AND pl."academyId" = ${academyId}), '[]'::json),
      'terms', COALESCE((SELECT json_agg(json_build_object('id', t."id", 'planId', t."planId", 'effectiveYear', t."effectiveYear",
          'effectiveMonth', t."effectiveMonth", 'priceAmount', t."priceAmount"::text, 'currency', t."currency"::text, 'monthsCovered', t."monthsCovered"))
        FROM "PaymentPlanTerms" t JOIN "PaymentPlan" tp ON tp."id" = t."planId" AND tp."organizationId" = t."organizationId"
        WHERE t."organizationId" = ${organizationId} AND tp."academyId" = ${academyId}), '[]'::json)
    ) AS content`;
  const c = row.content;
  return {
    organization: { id: organizationId, currency: "" }, // not part of a student or branch fingerprint
    branches: c.branches,
    plans: c.plans,
    terms: c.terms,
    policies: c.policies,
    students: c.students,
    statusChanges: c.statusChanges,
    assignments: c.assignments,
    legacyPayments: c.legacyPayments,
    monthlyObligations: c.monthlyObligations,
    coverage: c.coverage,
    openingItems: c.drafts
      .filter((d) => !d.withdrawn)
      .map(({ id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }) => ({
        id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId,
      })),
    withdrawnOpeningItems: c.drafts
      .filter((d) => d.withdrawn)
      .map(({ id, studentId, withdrawalKind, supersededById }) => ({ id, studentId, withdrawalKind: withdrawalKind!, supersededById })),
    confirmations: [],
  };
}

export type Declaration = "noOpeningDebt" | "itemsAsShown";

/**
 * Plan §4.2: one confirmation, appended. Under the locks: read the content (one statement), recompute the binding, compare it
 * with the one the owner submitted (refuse `stale` on any difference), check the declaration against the active drafts in that
 * same content, THEN read MAX(sequence) for the identity — after the lock, so it sees every confirmation committed before the
 * grant — and insert MAX + 1. `confirmedAt` is display only.
 */
export async function recordConfirmationCore(
  context: TenantContext,
  input: { studentId: string; candidate: YearMonth; kind: DuesReadinessConfirmationKind; binding: string; declaration: Declaration | null },
  hooks: TestHooks = {},
): Promise<ActionState> {
  const student = await findStudent(context.organizationId, input.studentId);
  if (!student) return { error: "notFound" };

  return underStudentLock(context, student, hooks, false, async (tx) => {
    const content = await loadReviewContentInTx(tx, context.organizationId, student.id, student.homeAcademyId);
    await hooks.afterContentRead?.(tx);
    const studentFp = studentFingerprint(content, student.id);
    const branchFp = input.kind === "PRICING_ACKNOWLEDGED" ? branchFingerprint(content, student.homeAcademyId) : null;
    const fresh = branchFp === null ? openingReviewBinding(input.candidate, studentFp) : pricingAckBinding(input.candidate, studentFp, branchFp);
    if (fresh !== input.binding) return reject({ error: "stale" });

    let declaredNoOpeningDebt: boolean | null = null;
    if (input.kind === "OPENING_REVIEWED") {
      const activeDrafts = content.openingItems.length;
      if (input.declaration === "noOpeningDebt" ? activeDrafts !== 0 : activeDrafts === 0) {
        return reject({ error: "invalid", fieldErrors: { declaration: ["mismatch"] } });
      }
      declaredNoOpeningDebt = input.declaration === "noOpeningDebt";
    }

    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(MAX("sequence"), 0) + 1 AS next FROM "DuesReadinessConfirmation"
      WHERE "organizationId" = ${context.organizationId} AND "studentId" = ${student.id}
        AND "candidateYear" = ${input.candidate.year} AND "candidateMonth" = ${input.candidate.month}
        AND "kind" = ${input.kind}::"DuesReadinessConfirmationKind"`;
    const created = await tx.duesReadinessConfirmation.create({
      data: {
        organizationId: context.organizationId,
        studentId: student.id,
        candidateYear: input.candidate.year,
        candidateMonth: input.candidate.month,
        kind: input.kind,
        sequence: next,
        fingerprintFormat: FINGERPRINT_FORMAT,
        binding: fresh,
        studentFingerprint: studentFp,
        branchFingerprint: branchFp,
        declaredNoOpeningDebt,
        confirmedById: context.actorUserId,
      },
    });
    await hooks.beforeAudit?.(tx);
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: student.homeAcademyId,
        action: "duesReadinessConfirmation.record",
        entityType: "DuesReadinessConfirmation",
        entityId: created.id,
        before: Prisma.DbNull,
        after: {
          studentId: student.id,
          kind: input.kind,
          candidate: `${input.candidate.year}-${String(input.candidate.month).padStart(2, "0")}`,
          sequence: next,
          binding: fresh,
          declaredNoOpeningDebt,
        },
      },
    });
    await hooks.afterAudit?.(tx);
    return null;
  });
}
