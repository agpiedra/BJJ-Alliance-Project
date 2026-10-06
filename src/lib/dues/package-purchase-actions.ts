"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { PaymentMethod, type Currency } from "@/generated/prisma/client";
import { resolveActionContext } from "@/lib/tenant/context";
import { purchasePackageWithSubmissionIdentity, type PurchasePackageWithSubmissionIdentityResult } from "@/lib/dues/ledger/purchase-submission-identity";
import { listActivePackagePlanOptions, firstAvailablePackageMonth, type PackagePlanOption, type FirstAvailablePackageMonthResult } from "@/lib/dues/package-purchase-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { CalendarDate, YearMonth } from "@/lib/dues/calendar";

/**
 * Package-purchase UI brief §2/§5/§11: the `"use server"` layer over `purchasePackageWithSubmissionIdentity` (already
 * merged, PR #91) — mirrors `payment-entry-actions.ts`'s own structure exactly. Every export independently calls its
 * own authorization, the same "every export in a `"use server"` file is independently client-invocable" rule that
 * file already follows.
 *
 * AUTHORIZATION ASYMMETRY FROM THE ORDINARY CARD: `purchasePackageWithSubmissionIdentity` is hard-coded ADMIN-only in
 * the engine itself (`purchase-submission-identity.ts:159`: `if (context.organizationRole !== "ADMIN") return {
 * ok: false, error: "notFound" }`) — this action's own pre-check matches it, ADMIN only, never DIRECTOR (D5's
 * DIRECTOR carve-out never applied to this writer).
 *
 * D4 (approved, brief §3 decision 3): `maxBackdateDays` is this literal server-side constant — never read from
 * `formData`, no client override of any kind — the identical policy value `payment-entry-actions.ts` already uses
 * for the ordinary writer, now extended to this one too.
 */
const MAX_BACKDATE_DAYS = 30;

const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDateInput(raw: string | null): CalendarDate | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseYearMonthInput(raw: string | null): YearMonth | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

async function refreshPaymentsPage(): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments`);
  } catch (error) {
    console.error("[package-purchase-actions] failed to revalidate", { error });
  }
}

/** Mirrors `payment-entry-actions.ts`'s own `wroteSomethingNew` exactly — a newly-written financial record is the
 * only case this page's own data has actually changed; a replay reports something that already existed, and every
 * refusal wrote nothing. */
function wroteSomethingNew(result: PurchasePackageWithSubmissionIdentityResult): boolean {
  if (result.ok) return !("replay" in result);
  return result.error === "captured" && !("replay" in result);
}

/**
 * Purchase ONE package, idempotently keyed by the caller's own `submissionId` (brief §2.6/§2.10). ADMIN only — the
 * role check happens here; `purchasePackageWithSubmissionIdentity`'s own identical check (internal to that function)
 * is what actually enforces it regardless, exactly mirroring `recordPayment`'s own two-layer precedent.
 *
 * No `deps` override of any kind — production activation stays the real, unmodified `inactiveLedgerActivation`
 * default every other ledger action in this codebase already uses.
 */
export async function purchasePackage(
  organizationId: string,
  _prevState: PurchasePackageWithSubmissionIdentityResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<PurchasePackageWithSubmissionIdentityResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const studentId = text(formData, "studentId");
  const planTermsId = text(formData, "planTermsId");
  const requestedStartMonth = parseYearMonthInput(text(formData, "requestedStartMonth"));
  const existingObligationIds = formData.getAll("existingObligationIds").filter((v): v is string => typeof v === "string" && v.length > 0);
  const receivedOn = parseDateInput(text(formData, "receivedOn"));
  const tenderCurrency = text(formData, "tenderCurrency");
  const tenderAmount = text(formData, "tenderAmount");
  const method = text(formData, "method");
  const notesRaw = text(formData, "notes");
  const notes = notesRaw === null || notesRaw === "" ? undefined : notesRaw;
  const submissionId = text(formData, "submissionId");

  if (
    !isNonBlankString(studentId) ||
    !isNonBlankString(planTermsId) ||
    !requestedStartMonth ||
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

  const result = await purchasePackageWithSubmissionIdentity({
    context,
    studentId,
    planTermsId,
    requestedStartMonth,
    existingObligationIds,
    receivedOn,
    tender: { currency: tenderCurrency as Currency, amount: tenderAmount },
    method: method as PaymentMethod,
    notes,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    submissionId,
  });

  if (wroteSomethingNew(result)) await refreshPaymentsPage();
  return result;
}

export type GetPackagePlanOptionsResult = { ok: true; plans: PackagePlanOption[] } | { ok: false; error: "notFound" };

/** Deliverable 1: the plan/terms picker read, bridged to the client exactly like `getPayableObligations` bridges
 * `listPayableObligations`. ADMIN only, matching this card's own display gate (never DIRECTOR). */
export async function getPackagePlanOptions(organizationId: string, studentId: string): Promise<GetPackagePlanOptionsResult> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  return listActivePackagePlanOptions(auth.context, studentId);
}

/** Deliverable 2: the first-available-month advisory read, bridged the same way. ADMIN only. */
export async function getFirstAvailablePackageMonth(organizationId: string, studentId: string): Promise<FirstAvailablePackageMonthResult> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  return firstAvailablePackageMonth(auth.context, studentId);
}
