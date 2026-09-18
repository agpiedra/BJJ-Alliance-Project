"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTenantContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — the wizard's own step 1 (name
 * confirmation). Steps 2/3 (logo/theme) need no dedicated save action at
 * all: they embed Phase 4's LogoUploader/ThemePicker components AS-IS with
 * their existing admin/branding actions — "reuse the Phase 4 components"
 * per the doc's own explicit instruction not to write a second logo
 * uploader or color picker. This file only owns what's genuinely new: the
 * name-confirmation save, and step navigation (advance/complete), each
 * audited the same way every other branding change already is.
 */
const step1Schema = z.object({
  name: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
});

async function auditOnboardingEvent(
  actorId: string,
  organizationId: string,
  action: string,
  after: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      organizationId,
      academyId: null,
      action,
      entityType: "Organization",
      entityId: organizationId,
      before: Prisma.DbNull,
      after,
    },
  });
}

export async function saveOnboardingStep1(
  locale: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  const parsed = step1Schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: context.organizationId },
      data: { name: data.name, onboardingStep: 2 },
    });
    await tx.organizationBranding.upsert({
      where: { organizationId: context.organizationId },
      update: { displayName: data.displayName || null },
      create: { organizationId: context.organizationId, displayName: data.displayName || null },
    });
    await auditOnboardingEvent(context.actorUserId, context.organizationId, "organization.onboardingStep1", {
      name: data.name,
      displayName: data.displayName || null,
    });
  });

  redirect(`/${locale}/onboarding`);
}

/**
 * Steps 2 (logo) and 3 (theme) each have their own real save action already
 * (LogoUploader/ThemePicker's admin/branding actions) — this only advances
 * the wizard's OWN step pointer after the director is done with that step's
 * embedded control (whether they uploaded/customized something or not,
 * which is exactly what makes "skip this step" and "done with this step"
 * the same action here).
 */
export async function advanceOnboardingStep(locale: string, toStep: number): Promise<void> {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  await prisma.organization.update({
    where: { id: context.organizationId },
    data: { onboardingStep: toStep },
  });
  await auditOnboardingEvent(context.actorUserId, context.organizationId, "organization.onboardingStepAdvanced", {
    toStep,
  });
  redirect(`/${locale}/onboarding`);
}

/**
 * Both the wizard's own "Finish" (after step 3) and the doc's explicit
 * "Lo haré después / I'll do this later" skip land here — the doc
 * describes them as producing the identical end state (onboardingCompletedAt
 * set, dashboard with defaults intact), so this is deliberately one action,
 * not two indistinguishable copies.
 */
export async function completeOnboarding(locale: string): Promise<void> {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  await prisma.organization.update({
    where: { id: context.organizationId },
    data: { onboardingCompletedAt: new Date() },
  });
  await auditOnboardingEvent(context.actorUserId, context.organizationId, "organization.onboardingCompleted", {
    completedAt: new Date().toISOString(),
  });
  redirect(`/${locale}/dashboard`);
}
