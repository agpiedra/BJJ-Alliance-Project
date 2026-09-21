"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import type { ActionState } from "@/lib/action-state";
import {
  inviteStaffMember,
  resendStaffInvitation,
  revokeStaffInvitation,
  setMembershipActive,
  updateStaffMembership,
  STAFF_ROLES,
  type InvitationDelivery,
  type StaffResult,
} from "@/lib/staff/staff-service";

/**
 * Staff management — OWNER ONLY. Every action resolves the caller's context
 * for the organization it NAMES (never the ambient session selector) and
 * demands `ADMIN`: a location director or instructor is refused (`FORBIDDEN`),
 * a caller with no membership in that organization is told `notFound` — the
 * same "disclose to members, never to non-members" rule every other action
 * follows. The rules themselves live in `staff-service.ts`;
 * `tests/unit/staff-actions-are-owner-only.test.ts` fails the build if any
 * exported action here stops demanding the Owner.
 */

/** What issuing or resending an invitation hands back: the link is always
 * returned so the Owner can copy it when the email never arrives. */
export type StaffInviteState = ActionState & Partial<InvitationDelivery>;

async function refreshStaffPage(): Promise<void> {
  // Best-effort, same shape as the payment actions: revalidatePath needs a real
  // request-scoped store that a direct test call doesn't have, and the write
  // has already committed.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/admin/staff`);
  } catch (error) {
    console.error("[staff-actions] failed to revalidate", { error });
  }
}

function toState(result: StaffResult<Partial<InvitationDelivery>>): StaffInviteState {
  if ("error" in result) return { error: result.error };
  return { ...result };
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(STAFF_ROLES),
  academyIds: z.array(z.string().min(1)),
});

const updateSchema = z.object({
  membershipId: z.string().min(1),
  // Staff roles, plus "Student only" — taking staff access away and keeping the training.
  role: z.enum([...STAFF_ROLES, "STUDENT"]),
  academyIds: z.array(z.string().min(1)),
});

function strings(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === "string" && value.length > 0);
}

export async function inviteStaff(organizationId: string, _prevState: ActionState, formData: FormData): Promise<StaffInviteState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
    academyIds: strings(formData, "academyIds"),
  });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };

  const result = toState(await inviteStaffMember(auth.context, parsed.data));
  if (result.ok) await refreshStaffPage();
  return result;
}

export async function updateStaffMember(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = updateSchema.safeParse({
    membershipId: formData.get("membershipId"),
    role: formData.get("role"),
    academyIds: strings(formData, "academyIds"),
  });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };

  const result = toState(await updateStaffMembership(auth.context, parsed.data.membershipId, parsed.data));
  if (result.ok) await refreshStaffPage();
  return result;
}

export async function deactivateStaffMember(organizationId: string, membershipId: string): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const result = toState(await setMembershipActive(auth.context, membershipId, false));
  if (result.ok) await refreshStaffPage();
  return result;
}

export async function reactivateStaffMember(organizationId: string, membershipId: string): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const result = toState(await setMembershipActive(auth.context, membershipId, true));
  if (result.ok) await refreshStaffPage();
  return result;
}

export async function resendInvitation(organizationId: string, invitationId: string): Promise<StaffInviteState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const result = toState(await resendStaffInvitation(auth.context, invitationId));
  if (result.ok) await refreshStaffPage();
  return result;
}

export async function revokeInvitation(organizationId: string, invitationId: string): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const result = toState(await revokeStaffInvitation(auth.context, invitationId));
  if (result.ok) await refreshStaffPage();
  return result;
}
