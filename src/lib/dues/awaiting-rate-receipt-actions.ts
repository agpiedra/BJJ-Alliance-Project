"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import { resolveAwaitingRateReceipt, cancelAwaitingRateReceipt } from "@/lib/dues/ledger/awaiting-rate-receipt";
import { findReceiptStatus, listAwaitingRateReceipts, type AwaitingRateReceiptRow, type AwaitingRateReceiptStatusFilter } from "@/lib/dues/awaiting-rate-receipt-queries";
import type { ActionState } from "@/lib/action-state";

/**
 * Owner-only UI for the awaiting-rate receipt queue (this feature's own planning brief:
 * Payment Schedules Proposal/OWNER-AWAITING-RATE-RECEIPT-QUEUE-UI-BRIEF.md). Every export below independently calls
 * `resolveActionContext(organizationId, ["ADMIN"])` itself — the established "every export in a `"use server"` file
 * is independently client-invocable, so every export must independently defend itself" rule.
 *
 * `resolveReceipt`/`cancelReceipt` are thin wrappers: ALL business logic (drift re-validation, the student lock, the
 * conditional PENDING-only update, the owner-role check, the activation check) lives in
 * `resolveAwaitingRateReceipt`/`cancelAwaitingRateReceipt` (awaiting-rate-receipt.ts), unchanged. Neither ever passes
 * a `deps` argument — production activation stays exactly the hardcoded-false `inactiveLedgerActivation` default
 * those functions already apply on their own; nothing client-reachable can ever override it.
 */

const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function refreshReceiptQueuePage(): Promise<void> {
  // Best-effort, same shape as exchange-rate-actions.ts's own refresh helper: a direct test call has no
  // request-scoped store, and the write has already committed by the time this runs.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments/plans`);
  } catch (error) {
    console.error("[awaiting-rate-receipt-actions] failed to revalidate", { error });
  }
}

/**
 * Corrected revalidation rule (this feature's own brief, correction #3): the queue is refreshed on `ok: true` AND on
 * `alreadyResolved`/`alreadyCancelled` — both mean the stored truth changed even though THIS call didn't cause a
 * successful write (something else already resolved/cancelled it). No other error value implies a server-side state
 * change, so no other error value triggers a refresh.
 */
function impliesStoredStateChanged(result: { ok: true } | { ok: false; error: string }): boolean {
  return result.ok || result.error === "alreadyResolved" || result.error === "alreadyCancelled";
}

/** Owner-only resolution of a PENDING receipt — takes only `receiptId`, exactly mirroring the engine's own narrow
 * signature (no `receivedOn`, no tender, no override of any kind). */
export async function resolveReceipt(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const receiptId = text(formData, "receiptId");
  if (!isNonBlankString(receiptId)) return { error: "invalid" };

  const result = await resolveAwaitingRateReceipt({ context, receiptId });
  if (impliesStoredStateChanged(result)) await refreshReceiptQueuePage();
  if (!result.ok) return { error: result.error };
  return { ok: true };
}

/** Owner-only cancellation of a PENDING receipt — a required, non-blank `reason`, checked locally before the engine
 * is ever called (the engine's own identical check remains the authoritative one). */
export async function cancelReceipt(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const receiptId = text(formData, "receiptId");
  const reason = text(formData, "reason");
  if (!isNonBlankString(receiptId) || !isNonBlankString(reason)) return { error: "invalid" };

  const result = await cancelAwaitingRateReceipt({ context, receiptId, reason });
  if (impliesStoredStateChanged(result)) await refreshReceiptQueuePage();
  if (!result.ok) return { error: result.error };
  return { ok: true };
}

/**
 * The terminal-status-refresh read: on an `alreadyResolved`/`alreadyCancelled` result from either action above, a
 * row re-fetches its own authoritative status through this and updates its displayed controls to match — never left
 * showing a stale PENDING badge next to an error message. Not activation-gated (a read, same as
 * `getExchangeRateCorrectionWarning`'s own established shape) — a non-owner has no legitimate reason to call this
 * and there is nothing sensitive in a bare status, so a failed auth check returns `null` rather than a thrown error.
 */
export async function getReceiptStatus(organizationId: string, receiptId: string): Promise<{ status: "PENDING" | "RESOLVED" | "CANCELLED" } | null> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return null;
  return findReceiptStatus(organizationId, receiptId);
}

/**
 * The status-filtered, cursor-paginated list read, called directly from the client list/tab/"load more" UI — the
 * same "a client component calls a `"use server"` read function directly" precedent `getCurrentExchangeRate`/
 * `getExchangeRateCorrectionWarning` already established, chosen over URL-param-driven server rendering because it
 * keeps tab-switching and paging interactive without a full page reload, with no new page/searchParams plumbing.
 * Not activation-gated (a read) — an empty result on a failed auth check, never a thrown error, matching
 * `getReceiptStatus`'s own shape.
 */
export async function listReceipts(
  organizationId: string,
  args: { status?: AwaitingRateReceiptStatusFilter; limit?: number; cursor?: string } = {},
): Promise<{ rows: AwaitingRateReceiptRow[]; nextCursor: string | null }> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { rows: [], nextCursor: null };
  return listAwaitingRateReceipts(organizationId, args);
}
