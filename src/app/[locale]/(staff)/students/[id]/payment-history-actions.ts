"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import { listPaymentHistoryForStudent, type PaymentHistoryRow } from "@/lib/dues/payment-history-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.1: the thin "use server" bridge for "load more" (page 2+) only —
 * page 1 is read directly by the student-detail Server Component, which already has a resolved `TenantContext`.
 * Re-resolves authorization FRESH on every call (`resolveActionContext`, same per-invocation discipline
 * `financial-corrections-actions.ts`'s own `getCorrectableLateFees`/`getReversiblePayments` already use) — never a
 * staleness window inherited from page 1's own earlier check. Same view-gate roles as the page itself's own
 * tenant-context resolution (ADMIN/DIRECTOR/INSTRUCTOR) — payment-history VIEWING, unlike the ADMIN-only
 * financial-corrections UI, is available to all three staff roles.
 *
 * Does not import `dues/ledger` directly (only `@/lib/dues/payment-history-queries`), so it needs no
 * `AUTHORIZED_CALLERS` entry in `tests/unit/dues-ledger-not-exposed.test.ts`.
 */
/** Same "disclose to members, never to non-members" discipline every action in this codebase follows: `notFound`
 * is the one generic refusal code for "not authenticated, not a member, or wrong role" — distinct from the
 * reader's own `notActive`/`invalid`, and from `unavailable` (a genuine thrown read failure). The client component
 * only ever branches on `ok`, but keeping these distinct is what makes authorization independently testable/
 * auditable, the same way every other action in this codebase's own `{error:"notFound"}` convention is. */
export type PaymentHistoryPage =
  | { ok: true; rows: PaymentHistoryRow[]; nextCursor: string | null }
  | { ok: false; error: "notFound" | "notActive" | "invalid" | "unavailable" };

export async function getPaymentHistoryPage(organizationId: string, studentId: string, cursor?: string): Promise<PaymentHistoryPage> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { ok: false, error: "notFound" };

  try {
    const result = await listPaymentHistoryForStudent(auth.context, studentId, { cursor });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, rows: result.rows, nextCursor: result.nextCursor };
  } catch {
    // A genuine read failure (the reader's own real-DB-failure contract — PR #95) renders "couldn't load more",
    // never an empty/zero/false-safe page.
    return { ok: false, error: "unavailable" };
  }
}
