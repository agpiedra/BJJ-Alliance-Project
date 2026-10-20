"use server";

import { resolveActionContext } from "@/lib/tenant/context";
import type { ActionState } from "@/lib/action-state";
import type { TenantContext } from "@/lib/tenant/types";
import {
  createOpeningDraftCore,
  parseBinding,
  parseCandidate,
  parseDraftContent,
  parseReason,
  recordConfirmationCore,
  replaceOpeningDraftCore,
  withdrawOpeningDraftCore,
  type Declaration,
} from "@/lib/dues/readiness/opening-core";

/**
 * Stage 8 PR 8c: the owner's five actions over opening-debt drafts and readiness confirmations. Every export of a "use server"
 * file is a callable action, so this file exports exactly these five and nothing else (tests/unit/dues-readiness-not-exposed.test.ts).
 * Built ahead of the owner screen (8d), registered in scripts/pending-callers.ts; no screen calls them yet.
 *
 * Authorization comes first and is server-derived: owner (`ADMIN`) of THIS organization only. A non-member gets `notFound`, and
 * `resolveActionContext`'s existing `organization.accessRefused` audit row records the refusal (unchanged). A member with another
 * role is refused through its `FORBIDDEN` error, mapped to the same `notFound` (brief §11: Directors learn nothing), as
 * `getDuesReadinessForOwner` does. The actor is always the session user; no form field can name an actor, an organization, a
 * fingerprint the server did not compute, or a reference the server did not re-read in this organization.
 *
 * Fields are read one by one from FormData (never a strict schema over the whole FormData, which also carries `$ACTION_*` keys).
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

const reader = (formData: FormData) => (name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

export async function createOpeningDraft(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const context = await owner(organizationId);
  if (!context) return { error: "notFound" };
  const read = reader(formData);
  const studentId = read("studentId");
  if (!studentId) return { error: "notFound" };
  const content = parseDraftContent(read);
  if (!content.ok) return { error: "invalid", fieldErrors: content.fieldErrors };
  return createOpeningDraftCore(context, studentId, content.value);
}

export async function replaceOpeningDraft(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const context = await owner(organizationId);
  if (!context) return { error: "notFound" };
  const read = reader(formData);
  const draftId = read("draftId");
  if (!draftId) return { error: "notFound" };
  const content = parseDraftContent(read);
  if (!content.ok) return { error: "invalid", fieldErrors: content.fieldErrors };
  return replaceOpeningDraftCore(context, draftId, content.value);
}

export async function withdrawOpeningDraft(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const context = await owner(organizationId);
  if (!context) return { error: "notFound" };
  const read = reader(formData);
  const draftId = read("draftId");
  if (!draftId) return { error: "notFound" };
  const reason = parseReason(read("reason"));
  if (reason === null) return { error: "invalid", fieldErrors: { reason: ["invalid"] } };
  return withdrawOpeningDraftCore(context, draftId, reason);
}

function readConfirmation(read: (name: string) => string | null) {
  const fieldErrors: Record<string, string[]> = {};
  const candidate = parseCandidate(read("candidateYear"), read("candidateMonth"));
  if (!candidate) fieldErrors.candidateMonth = ["invalid"];
  const binding = parseBinding(read("binding"));
  if (!binding) fieldErrors.binding = ["invalid"];
  return { candidate, binding, fieldErrors };
}

export async function recordOpeningReview(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const context = await owner(organizationId);
  if (!context) return { error: "notFound" };
  const read = reader(formData);
  const studentId = read("studentId");
  if (!studentId) return { error: "notFound" };
  const { candidate, binding, fieldErrors } = readConfirmation(read);
  const declarationRaw = read("declaration");
  const declaration: Declaration | null = declarationRaw === "noOpeningDebt" || declarationRaw === "itemsAsShown" ? declarationRaw : null;
  if (!declaration) fieldErrors.declaration = ["invalid"];
  if (!candidate || !binding || !declaration) return { error: "invalid", fieldErrors };
  return recordConfirmationCore(context, { studentId, candidate, kind: "OPENING_REVIEWED", binding, declaration });
}

export async function acknowledgePricing(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const context = await owner(organizationId);
  if (!context) return { error: "notFound" };
  const read = reader(formData);
  const studentId = read("studentId");
  if (!studentId) return { error: "notFound" };
  const { candidate, binding, fieldErrors } = readConfirmation(read);
  if (!candidate || !binding) return { error: "invalid", fieldErrors };
  return recordConfirmationCore(context, { studentId, candidate, kind: "PRICING_ACKNOWLEDGED", binding, declaration: null });
}
