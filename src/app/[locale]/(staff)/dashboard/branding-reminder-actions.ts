"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — dismisses the dashboard's "you
 * skipped branding, finish it here" card. `Organization` is not a
 * tenant-scoped model (it IS the tenant — see `(staff)/layout.tsx`'s own
 * identical `prisma.organization.findUnique` pattern for the onboarding
 * redirect), so this writes through the plain guarded `prisma` client,
 * scoped by `context.organizationId` from a verified ADMIN/DIRECTOR
 * session — never a client-supplied id.
 *
 * Per-organization, not per-browser: a director dismissing this on one
 * device must not see it reappear on another.
 */
export async function dismissBrandingReminder(): Promise<void> {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  await prisma.organization.update({
    where: { id: context.organizationId },
    data: { brandingReminderDismissedAt: new Date() },
  });

  // Best-effort, not fatal — same reasoning as self-check-in-action.ts's own
  // identical try/catch: revalidatePath requires a real Next.js
  // request-scoped store, absent when this action is called directly (e.g.
  // by an integration test invoking the exported function). The dismissal
  // itself already committed above regardless of this outcome.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/dashboard`);
  } catch (error) {
    console.error("[dashboard] failed to revalidate /dashboard after dismissing branding reminder", { error });
  }
}
