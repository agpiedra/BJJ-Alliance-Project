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
 * file and not a route — nothing can call it from a browser; the owner screen (PR 8d) will call it from server code. It
 * reads one PostgreSQL-enforced REPEATABLE READ, READ ONLY snapshot, writes nothing and calls no ledger writer.
 *
 * Owner (`ADMIN`) of THIS organization only. Everyone else gets the same `notFound`: a non-member through
 * `resolveActionContext`'s own refusal, and a genuine member with another role through its `FORBIDDEN` error, mapped here so
 * a Director learns nothing about readiness. Any other error is not swallowed.
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
