"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import type { TenantContext } from "@/lib/tenant/types";
import { parseCandidate } from "@/lib/dues/readiness/opening-core";
import {
  activateCore,
  approveActivationCore,
  withdrawApprovalCore,
  type ActivateResult,
  type ApproveResult,
  type WithdrawResult,
} from "@/lib/dues/readiness/activation-core";

/**
 * Stage 9 PR 9-3: the owner's three activation actions (A7: owner only — not Directors, not platform staff). Every export of a
 * "use server" file is a callable action, so this file exports exactly these three (tests/unit/dues-readiness-not-exposed.test.ts).
 *
 * Authorization first, server-derived: owner (`ADMIN`) of THIS organization; anyone else gets `notFound` (a non-member's refusal
 * keeps `resolveActionContext`'s `organization.accessRefused` audit row). The actor is always the session user. No field names an
 * actor, a clock, an approval or a fingerprint the server does not recompute: approval's `organizationFingerprint` is only
 * compared with the one recomputed under the gate (the owner approves exactly the report they were shown, or gets `stale`).
 */
async function owner(organizationId: string): Promise<TenantContext | null> {
  try {
    const auth = await resolveActionContext(organizationId, ["ADMIN"]);
    return auth.ok ? auth.context : null;
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") return null;
    throw error;
  }
}

const HASH = /^[0-9a-f]{64}$/;

export async function approveActivation(organizationId: string, formData: FormData): Promise<ApproveResult> {
  const context = await owner(organizationId);
  if (!context) return { ok: false, error: "notFound" };
  const read = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : null;
  };
  const candidate = parseCandidate(read("candidateYear"), read("candidateMonth"));
  const organizationFingerprint = read("organizationFingerprint");
  if (!candidate || !organizationFingerprint || !HASH.test(organizationFingerprint)) return { ok: false, error: "invalid" };
  return approveActivationCore(context, { candidate, organizationFingerprint });
}

export async function withdrawActivationApproval(organizationId: string): Promise<WithdrawResult> {
  const context = await owner(organizationId);
  if (!context) return { ok: false, error: "notFound" };
  return withdrawApprovalCore(context);
}

export async function activateLedger(organizationId: string): Promise<ActivateResult> {
  const context = await owner(organizationId);
  if (!context) return { ok: false, error: "notFound" };
  return activateCore(context);
}
