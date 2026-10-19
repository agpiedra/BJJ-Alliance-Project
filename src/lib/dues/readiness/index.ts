import { prisma } from "@/lib/prisma";
import { resolveActionContext } from "@/lib/tenant/context";
import { runReadOnlySnapshot } from "@/lib/db/read-only-snapshot";
import { assertYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { evaluateReadiness, type ReadinessReport } from "@/lib/dues/readiness/evaluate";
import { loadReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

export type DuesReadinessResult = { ok: true; report: ReadinessReport } | { ok: false; error: "notFound" | "invalid" };

/** The same rule as the ledger's `isValidCoverageMonth` (a calendar month in the schema's 2000-2100 range), restated here so
 * this read-only module never imports a writer module. */
function isCandidateMonth(month: YearMonth): boolean {
  try {
    assertYearMonth(month);
  } catch {
    return false;
  }
  return month.year >= 2000 && month.year <= 2100;
}

/**
 * Stage 8 PR 8a: the owner's read-only readiness report for one candidate start month. Deliberately NOT a `"use server"`
 * file and not a route — nothing can call it from a browser; the owner screen (PR 8d) will call it from server code.
 *
 * Two phases, with different guarantees:
 *  1. Authorization runs FIRST, through the shared `resolveActionContext`, outside any snapshot. Owner (`ADMIN`) of THIS
 *     organization only; everyone else gets the same `notFound`. A genuine member with another role is refused through its
 *     `FORBIDDEN` error, mapped here so a Director learns nothing. A NON-MEMBER's refusal is recorded by that helper's
 *     existing security audit (`organization.accessRefused` in `AuditLog`) — deliberately kept: this is the one write a
 *     call can cause, and it happens only when access is refused. Any other error is not swallowed.
 *  2. Only for an authorized owner, the snapshot is loaded inside one PostgreSQL-enforced REPEATABLE READ, READ ONLY
 *     transaction and evaluated. An authorized preview modifies no data and calls no ledger writer.
 */
export async function getDuesReadinessForOwner(organizationId: string, candidate: YearMonth): Promise<DuesReadinessResult> {
  if (!isCandidateMonth(candidate)) return { ok: false, error: "invalid" };

  let auth: Awaited<ReturnType<typeof resolveActionContext>>;
  try {
    auth = await resolveActionContext(organizationId, ["ADMIN"]);
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") return { ok: false, error: "notFound" };
    throw error;
  }
  if (!auth.ok) return { ok: false, error: "notFound" };
  const ownOrganizationId = auth.context.organizationId;

  const snapshot = await runReadOnlySnapshot(prisma, (tx) => loadReadinessSnapshot(tx, ownOrganizationId));
  return { ok: true, report: evaluateReadiness(snapshot, { year: candidate.year, month: candidate.month }) };
}
