"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import { listOwnPaymentHistory, type PortalPaymentHistoryRow } from "@/lib/dues/payment-history-queries";
import type { PortalSelfContext } from "@/lib/dues/portal-ledger-queries";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3.3/§4: the thin "use server" bridge for "load more" (page 2+)
 * only — page 1 is read directly by the portal Server Component, which already has a resolved context. Takes NO
 * `studentId` parameter at all (requirement 1: "no client-selected studentId") — the caller's own linked student
 * is re-derived fresh from the database on EVERY call, via `resolveActionContext` (same per-invocation discipline
 * `[id]/payment-history-actions.ts`'s own `getPaymentHistoryPage` already uses for the staff side), never
 * grandfathered from an earlier page's context. Available to every role `requirePortalContext` admits
 * (ADMIN/DIRECTOR/INSTRUCTOR/STUDENT) — a coach who also trains reaches their OWN history exactly like a pure
 * student, regardless of which branches they staff.
 *
 * Imports `PortalSelfContext` from `@/lib/dues/portal-ledger-queries` (a RE-EXPORT, not `dues/ledger/dues-facts`
 * directly) — so, unlike a direct import of that path would, this file needs no `AUTHORIZED_CALLERS` entry in
 * `tests/unit/dues-ledger-not-exposed.test.ts`; `portal-ledger-queries.ts` is the one new file that actually
 * imports `dues/ledger`, and is registered there instead.
 */
export type PortalPaymentHistoryPage =
  | { ok: true; rows: PortalPaymentHistoryRow[]; nextCursor: string | null }
  | { ok: false; error: "notFound" | "notActive" | "invalid" | "unavailable" };

export async function getOwnPaymentHistoryPage(organizationId: string, cursor?: string): Promise<PortalPaymentHistoryPage> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);
  if (!auth.ok) return { ok: false, error: "notFound" };
  if (!auth.context.linkedStudentId) return { ok: false, error: "notFound" };
  const selfContext: PortalSelfContext = { ...auth.context, linkedStudentId: auth.context.linkedStudentId };

  try {
    const result = await listOwnPaymentHistory(selfContext, { cursor });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, rows: result.rows, nextCursor: result.nextCursor };
  } catch {
    // A genuine read failure (the reader's own real-DB-failure contract) renders "couldn't load more", never an
    // empty/zero/false-safe page — same discipline `[id]/payment-history-actions.ts` already established.
    return { ok: false, error: "unavailable" };
  }
}
