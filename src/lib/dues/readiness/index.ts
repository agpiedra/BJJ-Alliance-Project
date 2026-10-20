import { prisma } from "@/lib/prisma";
import { resolveActionContext } from "@/lib/tenant/context";
import { runReadOnlySnapshot } from "@/lib/db/read-only-snapshot";
import type { YearMonth } from "@/lib/dues/calendar";
import { isCandidateMonth } from "@/lib/dues/readiness/candidate";
import { evaluateReadiness, type ReadinessReport } from "@/lib/dues/readiness/evaluate";
import { loadReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

export type DuesReadinessResult = { ok: true; report: ReadinessReport } | { ok: false; error: "notFound" | "invalid" };

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
/**
 * Phase 1 of every readiness read: the owner (`ADMIN`) of THIS organization, or null. Runs outside any snapshot. A member with
 * another role is refused through `resolveActionContext`'s `FORBIDDEN` error, mapped to null so a Director learns nothing; a
 * NON-MEMBER's refusal is recorded by that helper's existing `organization.accessRefused` audit row. Any other error propagates.
 * Shared by `getDuesReadinessForOwner` and the 8d screen read (`screen.ts`) so the two can never gate differently.
 */
export async function authorizeOwner(organizationId: string): Promise<string | null> {
  let auth: Awaited<ReturnType<typeof resolveActionContext>>;
  try {
    auth = await resolveActionContext(organizationId, ["ADMIN"]);
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") return null;
    throw error;
  }
  return auth.ok ? auth.context.organizationId : null;
}

export async function getDuesReadinessForOwner(organizationId: string, candidate: YearMonth): Promise<DuesReadinessResult> {
  if (!isCandidateMonth(candidate)) return { ok: false, error: "invalid" };
  const ownOrganizationId = await authorizeOwner(organizationId);
  if (ownOrganizationId === null) return { ok: false, error: "notFound" };

  const snapshot = await runReadOnlySnapshot(prisma, (tx) => loadReadinessSnapshot(tx, ownOrganizationId));
  return { ok: true, report: evaluateReadiness(snapshot, { year: candidate.year, month: candidate.month }) };
}
