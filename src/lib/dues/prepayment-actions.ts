"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { PaymentMethod, type Currency } from "@/generated/prisma/client";
import { resolveActionContext } from "@/lib/tenant/context";
import { prepayMonthlyObligationsWithSubmissionIdentity, type PrepayMonthlyObligationsWithSubmissionIdentityResult } from "@/lib/dues/ledger/purchase-submission-identity";
import { firstAvailablePrepaymentMonth, listMonthPrices, type FirstAvailablePrepaymentMonthResult, type ListMonthPricesResult } from "@/lib/dues/prepayment-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { CalendarDate, YearMonth } from "@/lib/dues/calendar";

/**
 * Monthly-prepayment UI brief §2/§5: the `"use server"` layer over `prepayMonthlyObligationsWithSubmissionIdentity`
 * (already merged, PR #91) — mirrors `package-purchase-actions.ts`'s own structure exactly.
 *
 * ADMIN only, matching `prepayMonthlyObligationsWithSubmissionIdentity`'s own hard-coded check
 * (`purchase-submission-identity.ts:337`) — never DIRECTOR.
 *
 * D4 (approved, extended to both purchase writers): `maxBackdateDays` is this literal server-side constant — never
 * read from `formData` — identical to `package-purchase-actions.ts`'s own `MAX_BACKDATE_DAYS`, never the engine's own
 * much larger sanity ceiling (`prepay-monthly.ts`'s `MAX_BACKDATE_DAYS = 3660`, an outer bound only).
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

function parseYearMonthInput(raw: string): YearMonth | null {
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

async function refreshPaymentsPage(): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments`);
  } catch (error) {
    console.error("[prepayment-actions] failed to revalidate", { error });
  }
}

/** Mirrors `package-purchase-actions.ts`'s own `wroteSomethingNew` exactly. */
function wroteSomethingNew(result: PrepayMonthlyObligationsWithSubmissionIdentityResult): boolean {
  if (result.ok) return !("replay" in result);
  return result.error === "captured" && !("replay" in result);
}

/**
 * Prepay ONE consecutive run of future months, idempotently keyed by the caller's own `submissionId`. ADMIN only —
 * the role check happens here; `prepayMonthlyObligationsWithSubmissionIdentity`'s own identical check (internal)
 * actually enforces it regardless, mirroring `purchasePackage`'s own two-layer precedent.
 *
 * No `deps` override of any kind — production activation stays the real, unmodified `inactiveLedgerActivation`
 * default every other ledger action in this codebase already uses.
 */
export async function prepayMonths(
  organizationId: string,
  _prevState: PrepayMonthlyObligationsWithSubmissionIdentityResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<PrepayMonthlyObligationsWithSubmissionIdentityResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const studentId = text(formData, "studentId");
  const requestedMonthsRaw = formData.getAll("requestedMonths").filter((v): v is string => typeof v === "string" && v.length > 0);
  const requestedMonths = requestedMonthsRaw.map(parseYearMonthInput);
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
    requestedMonths.length === 0 ||
    requestedMonths.some((m) => m === null) ||
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

  const result = await prepayMonthlyObligationsWithSubmissionIdentity({
    context,
    studentId,
    requestedMonths: requestedMonths as YearMonth[],
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

/** The first-available-month + horizon-end advisory read, bridged to the client. ADMIN only, matching this card's
 * own display gate (never DIRECTOR). */
export async function getFirstAvailablePrepaymentMonth(organizationId: string, studentId: string): Promise<FirstAvailablePrepaymentMonthResult> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  return firstAvailablePrepaymentMonth(auth.context, studentId);
}

/** The per-month effective-price read, bridged the same way. ADMIN only. */
export async function getMonthPrices(organizationId: string, studentId: string, months: YearMonth[]): Promise<ListMonthPricesResult> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  return listMonthPrices(auth.context, studentId, months);
}
