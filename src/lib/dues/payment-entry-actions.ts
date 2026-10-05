"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { PaymentMethod, type Currency } from "@/generated/prisma/client";
import { resolveActionContext } from "@/lib/tenant/context";
import { recordDuesPaymentWithSubmissionIdentity, getSubmissionOutcome, type RecordDuesPaymentWithSubmissionIdentityResult, type SubmissionOutcome } from "@/lib/dues/ledger/submission-identity";
import {
  listPayableObligations,
  orderPayableOldestFirst,
  isMixedCurrency,
  getStudentBranchLocalToday,
  type PayableObligation,
} from "@/lib/dues/payment-entry-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { CalendarDate } from "@/lib/dues/calendar";

/**
 * Ordinary payment-entry UI brief §8: the `"use server"` layer over the merged `recordDuesPaymentWithSubmissionIdentity`/
 * `getSubmissionOutcome` (PR #89). Every export independently calls its own authorization — the established
 * "every export in a `"use server"` file is independently client-invocable" rule this codebase already follows
 * (`awaiting-rate-receipt-actions.ts`).
 *
 * D4 (approved, §5): `maxBackdateDays` is this literal server-side constant — never read from `formData`, no client
 * override of any kind.
 */
const MAX_BACKDATE_DAYS = 30;

const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Native `<input type="date">` value ("YYYY-MM-DD") to a `CalendarDate` — no client-side date library, the platform
 * control already enforces the shape; this only re-parses it into the plain parts the engine takes. */
function parseDateInput(raw: string | null): CalendarDate | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

async function refreshPaymentsPage(): Promise<void> {
  // Best-effort, same shape as the other dues actions' own refresh helpers: a direct test call has no
  // request-scoped store, and the write has already committed by the time this runs.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments`);
  } catch (error) {
    console.error("[payment-entry-actions] failed to revalidate", { error });
  }
}

/** A newly-written financial record (brief §2.3 cases 1/3) — the ONLY cases this page's own data has actually
 * changed. A replay (cases 2/4) reports something that already existed; every refusal (cases 5/6) wrote nothing. */
function wroteSomethingNew(result: RecordDuesPaymentWithSubmissionIdentityResult): boolean {
  if (result.ok) return !("replay" in result);
  return result.error === "captured" && !("replay" in result);
}

/**
 * Record ONE ordinary dues payment, idempotently keyed by the caller's own `submissionId` (brief §2.4b). D5
 * (approved): `ADMIN`, or a `DIRECTOR` scoped to the student's own branch — the ROLE check happens here;
 * `recordDuesPaymentWithSubmissionIdentity`'s own `inTenantScope` check against the student's `homeAcademyId`
 * (unconditional, internal to that function) is what actually excludes an out-of-branch `DIRECTOR`, exactly mirroring
 * `getSubmissionOutcome`'s own two-layer split (§1) — this action never duplicates that check itself.
 *
 * No `deps` override of any kind — production activation stays the real, unmodified `inactiveLedgerActivation`
 * default every other ledger action in this codebase already uses.
 */
export async function recordPayment(
  organizationId: string,
  _prevState: RecordDuesPaymentWithSubmissionIdentityResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<RecordDuesPaymentWithSubmissionIdentityResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const studentId = text(formData, "studentId");
  const obligationIds = formData.getAll("obligationIds").filter((v): v is string => typeof v === "string" && v.length > 0);
  const receivedOn = parseDateInput(text(formData, "receivedOn"));
  const tenderCurrency = text(formData, "tenderCurrency");
  const tenderAmount = text(formData, "tenderAmount");
  const method = text(formData, "method");
  const notesRaw = text(formData, "notes");
  const notes = notesRaw === null || notesRaw === "" ? undefined : notesRaw;
  const submissionId = text(formData, "submissionId");

  if (
    !isNonBlankString(studentId) ||
    obligationIds.length === 0 ||
    !receivedOn ||
    !isNonBlankString(tenderCurrency) ||
    !(CURRENCIES as readonly string[]).includes(tenderCurrency) ||
    !isNonBlankString(tenderAmount) ||
    !isNonBlankString(method) ||
    !(Object.values(PaymentMethod) as string[]).includes(method) ||
    !isNonBlankString(submissionId)
  ) {
    return { ok: false, error: "invalid" };
  }

  const result = await recordDuesPaymentWithSubmissionIdentity({
    context,
    studentId,
    receivedOn,
    tender: { currency: tenderCurrency as Currency, amount: tenderAmount },
    method: method as PaymentMethod,
    obligationIds,
    notes,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    submissionId,
  });

  if (wroteSomethingNew(result)) await refreshPaymentsPage();
  return result;
}

/**
 * The authorized, read-only recovery check (brief §1/§2.4b) — a thin wrapper, nothing more: `submission-identity.ts`
 * is a plain module, not `"use server"`, so `getSubmissionOutcome`'s own `resolveActionContext`-backed authorization
 * is not directly client-invocable without this wrapper. Deliberately does NOT catch a thrown `FORBIDDEN` (a genuine
 * member with the wrong role) — it propagates to the caller exactly as `getSubmissionOutcome` itself produces it.
 */
export async function checkSubmissionOutcome(organizationId: string, submissionId: string): Promise<SubmissionOutcome> {
  return getSubmissionOutcome(organizationId, submissionId);
}

export type GetPayableObligationsResult =
  | { ok: true; obligations: PayableObligation[]; mixedCurrency: boolean; todayLocal: CalendarDate }
  | { ok: false; error: "notActive" | "invalid" | "notFound" };

/**
 * DEVIATION (flagged, not in brief §8's own file list): a thin `"use server"` wrapper around `payment-entry-queries.ts`'s
 * `listPayableObligations`, so the client-side student picker can fetch the SELECTED student's outstanding list
 * on demand — the brief's own §2.1 ("a student picker feeding `listDuesFactsForStudents` for the selected student")
 * needs a client-invocable bridge to that plain module, and this is the minimal one, mirroring `listReceipts`'s own
 * "called directly from client UI" precedent. D5's authorization applies identically to a read of one student's own
 * outstanding list.
 *
 * The global oldest-first ordering and the mixed-currency check (§2.1) are computed HERE, server-side, so the
 * client component never imports `payment-entry-queries.ts` directly (that module pulls in `prisma` transitively
 * through `dues-facts.ts`, which must never reach a client bundle).
 *
 * Point 7's correction: also resolves and returns the student's own BRANCH-local "today" (`todayIn(branch.timezone,
 * ...)`) — the same clock every engine date check judges against — so the component never falls back to the
 * owner's browser clock once a student/branch is actually known.
 */
export async function getPayableObligations(organizationId: string, studentId: string): Promise<GetPayableObligationsResult> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const result = await listPayableObligations(auth.context, studentId);
  if (!result.ok) return result;
  const todayLocal = await getStudentBranchLocalToday(auth.context, studentId);
  if (!todayLocal) return { ok: false, error: "notFound" };
  return { ok: true, obligations: orderPayableOldestFirst(result.obligations), mixedCurrency: isMixedCurrency(result.obligations), todayLocal };
}
