"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { PaymentMethod, type Currency } from "@/generated/prisma/client";
import { resolveActionContext } from "@/lib/tenant/context";
import { correctLateFeeAndSettle, type CorrectLateFeeResult } from "@/lib/dues/ledger/correct-late-fee";
import { reversePayment, type ReversePaymentResult } from "@/lib/dues/ledger/reverse-payment";
import { waiveLateFee, type WaiveLateFeeResult } from "@/lib/dues/ledger/waive-late-fee";
import {
  listCorrectableLateFees,
  listReversiblePayments,
  getLateFeeById,
  getPaymentById,
  type CorrectableLateFeeRow,
  type ReversiblePaymentRow,
  type LateFeeStatus,
  type PaymentStatus,
} from "@/lib/dues/financial-corrections-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { CalendarDate } from "@/lib/dues/calendar";

/**
 * Owner financial-corrections UI brief §2/§5: the `"use server"` layer over `correctLateFeeAndSettle`/
 * `reversePayment`/`waiveLateFee` (all three already merged, called by nothing until this). Mirrors
 * `package-purchase-actions.ts`/`awaiting-rate-receipt-actions.ts`'s own structure — every export independently
 * calls its own `resolveActionContext(organizationId, ["ADMIN"])`, the established "every export in a `"use server"`
 * file is independently client-invocable" rule.
 *
 * Brief §3 decision 1 (approved): NO submission-identity wrapper for any of these three writers — recovery is the
 * exact-target status-check pattern (`getLateFeeStatus`/`getPaymentStatus` below), never a client-generated
 * submissionId, never `payment-attempt-storage.ts`. Nothing here persists a draft to `localStorage`.
 *
 * Brief §3 decision 2 (approved): D4 extends to the correction writer — this literal, never client-supplied.
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

async function refreshPaymentsPage(): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments`);
  } catch (error) {
    console.error("[financial-corrections-actions] failed to revalidate", { error });
  }
}

/** Mirrors `awaiting-rate-receipt-actions.ts`'s own `impliesStoredStateChanged` — a successful write AND an
 * already-finalized refusal both mean the stored truth changed (something else already acted on this target),
 * either way the page's own cached data is stale and must refresh; any other refusal wrote nothing. */
function wroteOrDiscoveredChange(result: { ok: boolean; error?: string }): boolean {
  return result.ok || result.error === "alreadyRemoved" || result.error === "alreadyReversed" || result.error === "alreadySettled";
}

/** ADMIN only — the role check happens here; `correctLateFeeAndSettle`'s own identical check (internal) actually
 * enforces it regardless, mirroring every other writer action in this codebase's own two-layer precedent. No `deps`
 * override of any kind — production activation stays the real, unmodified `inactiveLedgerActivation` default. */
export async function correctLateFee(
  organizationId: string,
  _prevState: CorrectLateFeeResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<CorrectLateFeeResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const lateFeeId = text(formData, "lateFeeId");
  const expectedRevision = text(formData, "expectedRevision");
  const removalReason = text(formData, "removalReason");
  const receivedOn = parseDateInput(text(formData, "receivedOn"));
  const tenderCurrency = text(formData, "tenderCurrency");
  const tenderAmount = text(formData, "tenderAmount");
  const method = text(formData, "method");
  const notesRaw = text(formData, "notes");
  const notes = notesRaw === null || notesRaw === "" ? undefined : notesRaw;

  if (
    !isNonBlankString(lateFeeId) ||
    !isNonBlankString(expectedRevision) ||
    !isNonBlankString(removalReason) ||
    !receivedOn ||
    !isNonBlankString(tenderCurrency) ||
    !(CURRENCIES as readonly string[]).includes(tenderCurrency) ||
    !isNonBlankString(tenderAmount) ||
    !isNonBlankString(method) ||
    !(Object.values(PaymentMethod) as string[]).includes(method)
  ) {
    return { ok: false, error: "invalid" };
  }

  const result = await correctLateFeeAndSettle({
    context,
    lateFeeId,
    expectedRevision,
    removalReason,
    receivedOn,
    tender: { currency: tenderCurrency as Currency, amount: tenderAmount },
    method: method as PaymentMethod,
    notes,
    maxBackdateDays: MAX_BACKDATE_DAYS,
  });

  if (wroteOrDiscoveredChange(result)) await refreshPaymentsPage();
  return result;
}

/** ADMIN only, mirroring `correctLateFee`'s own two-layer precedent. No revision field — `reversePayment` has none
 * (brief §1: purely lock + fresh re-read, never optimistic). */
export async function reversePaymentAction(
  organizationId: string,
  _prevState: ReversePaymentResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<ReversePaymentResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const paymentId = text(formData, "paymentId");
  const reversalReason = text(formData, "reversalReason");
  if (!isNonBlankString(paymentId) || !isNonBlankString(reversalReason)) return { ok: false, error: "invalid" };

  const result = await reversePayment({ context, paymentId, reversalReason });
  if (wroteOrDiscoveredChange(result)) await refreshPaymentsPage();
  return result;
}

/** ADMIN only, mirroring the other two. No `receivedOn`/tender/method fields — `waiveLateFee` needs none of them
 * (brief §1: a waiver never composes a settlement). */
export async function waiveFee(
  organizationId: string,
  _prevState: WaiveLateFeeResult | { ok: false; error: "invalid" } | Record<string, never>,
  formData: FormData,
): Promise<WaiveLateFeeResult | { ok: false; error: "invalid" }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  const context = auth.context;

  const lateFeeId = text(formData, "lateFeeId");
  const expectedRevision = text(formData, "expectedRevision");
  const removalReason = text(formData, "removalReason");
  if (!isNonBlankString(lateFeeId) || !isNonBlankString(expectedRevision) || !isNonBlankString(removalReason)) return { ok: false, error: "invalid" };

  const result = await waiveLateFee({ context, lateFeeId, expectedRevision, removalReason });
  if (wroteOrDiscoveredChange(result)) await refreshPaymentsPage();
  return result;
}

/** The shared fee-selection list read (brief §2.2/§3 decision 3), bridged to the client. ADMIN only, matching this
 * card's own display gate (never DIRECTOR). */
export async function getCorrectableLateFees(organizationId: string, studentId: string): Promise<CorrectableLateFeeRow[]> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return [];
  return listCorrectableLateFees(auth.context, studentId);
}

/** The payment-selection list read, bridged the same way. ADMIN only. */
export async function getReversiblePayments(organizationId: string, studentId: string): Promise<ReversiblePaymentRow[]> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return [];
  return listReversiblePayments(auth.context, studentId);
}

/** The recovery read for a late fee (brief §2.5) — never filtered by `removedAt`, so it finds the exact target even
 * after a successful correction/waiver has removed it from the candidate list above. Not gated behind an extra
 * check beyond the standard ADMIN auth (a bare status read, same shape `getReceiptStatus` already established). */
export async function getLateFeeStatus(organizationId: string, feeId: string): Promise<LateFeeStatus | null> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return null;
  return getLateFeeById(auth.context, feeId);
}

/** `getLateFeeStatus`'s own exact counterpart for a payment. */
export async function getPaymentStatus(organizationId: string, paymentId: string): Promise<PaymentStatus | null> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return null;
  return getPaymentById(auth.context, paymentId);
}
