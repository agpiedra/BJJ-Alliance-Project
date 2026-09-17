"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth, unstable_update } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeCallbackUrl } from "@/lib/callback-url";

const selectOrganizationSchema = z.object({ organizationId: z.string().min(1) });

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C decision 4, point 6: never a
 * silent fallback to the user's first membership. This is the explicit
 * choice for a user with 2+ active memberships — the submitted
 * `organizationId` is NEVER trusted blindly; it must name a real, ACTIVE
 * membership row for the SIGNED-IN user (from `auth()`, never a client
 * field), exactly the same discipline `resolveActionContext` already
 * applies everywhere else.
 *
 * `unstable_update({ activeOrganizationId })` triggers the jwt callback's
 * own `trigger === "update"` branch (src/auth.ts), which also persists this
 * choice as `User.lastActiveOrganizationId` so it's the fast-path default
 * on the user's NEXT login — this page doesn't need to write that itself.
 */
export async function selectOrganization(
  locale: string,
  callbackUrl: string | undefined,
  formData: FormData,
): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect(`/${locale}/login`);
  }

  const parsed = selectOrganizationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    // Only reachable via a forged request — the rendered form only ever
    // submits one of the user's own real membership ids. No friendly error
    // state to show; just refuse and stay put.
    redirect(`/${locale}/select-organization`);
  }

  const membership = await prisma.organizationMembership.findFirst({
    where: { userId, organizationId: parsed.data.organizationId, organization: { status: "ACTIVE" } },
    select: { organizationId: true },
  });
  if (!membership) {
    redirect(`/${locale}/select-organization`);
  }

  await unstable_update({ activeOrganizationId: membership.organizationId });

  const safeCallbackUrl = sanitizeCallbackUrl(callbackUrl);
  if (safeCallbackUrl) {
    redirect(safeCallbackUrl);
  }
  redirect(`/${locale}/${session!.user!.role === "STUDENT" ? "portal" : "dashboard"}`);
}
