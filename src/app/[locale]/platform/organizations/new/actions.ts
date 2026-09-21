"use server";

import { z } from "zod";
import { resolveSuperAdminActionContext } from "@/lib/auth/require-super-admin";
import { prisma } from "@/lib/prisma";
import { formDataToObject } from "@/lib/form-data";
import { seedOrganizationDefaults } from "@/lib/organizations/seed-defaults";
import { approveOrganization } from "@/lib/organizations/approve-organization";
import type { ActionState } from "@/lib/action-state";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — "same fields as the public
 * form, plus direct ACTIVE status, director email, optional branding, and
 * a promotion preset." `z.strictObject`, matching the public form's own
 * item-1 correction (register-academy/actions.ts) — an unrecognized field
 * on this ADMIN-only form is worth the same genuine rejection, not a
 * silently-stripped one.
 */
const manualCreationSchema = z.strictObject({
  organizationName: z.string().min(1).max(200),
  desiredSlug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slugFormat"),
  country: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  directorEmail: z.string().email(),
  contactName: z.string().min(1).max(200),
  contactPhone: z.string().min(1).max(50),
  studentCountBand: z.string().min(1).max(50),
  preferredLocale: z.enum(["es", "en"]),
  promotionMode: z.enum(["ATTENDANCE", "TIME", "MANUAL"]),
});

export type ManualOrganizationCreationState = ActionState & { slugTaken?: boolean };

/**
 * Creates the `Organization` row directly `ACTIVE` (never `PENDING` — this
 * IS the approval, made by a platform admin instead of a self-serve
 * applicant), seeds branding + both rank catalogs via the same
 * `seedOrganizationDefaults` the public registration path uses, then calls
 * the SAME `approveOrganization()` every other path shares to create the
 * first branch, the director identity, and the invitation — "reusing the
 * same idempotent approval path" per the doc, literally: this function
 * creates the row, `approveOrganization` does everything after that,
 * identically to a self-serve registration that just got approved.
 */
export async function createOrganizationManually(
  _prevState: ManualOrganizationCreationState,
  formData: FormData,
): Promise<ManualOrganizationCreationState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  // Strips the framework's hidden `$ACTION_*` fields a real browser submission
  // carries, which the strict schema would reject as unknown — lib/form-data.ts.
  const parsed = manualCreationSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const existingSlug = await prisma.organization.findUnique({ where: { slug: data.desiredSlug }, select: { id: true } });
  if (existingSlug) {
    return { error: "slugTaken", slugTaken: true, fieldErrors: { desiredSlug: ["slugTaken"] } };
  }

  const organization = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: {
        slug: data.desiredSlug,
        name: data.organizationName,
        status: "ACTIVE",
        defaultLocale: data.preferredLocale,
        country: data.country,
        city: data.city,
        contactName: data.contactName,
        contactEmail: data.directorEmail,
        contactPhone: data.contactPhone,
        studentCountBand: data.studentCountBand,
        approvedAt: new Date(),
        approvedById: auth.context.actorUserId,
      },
    });
    await seedOrganizationDefaults(tx, created.id, data.promotionMode);
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId: created.id,
        action: "organization.createManual",
        entityType: "Organization",
        entityId: created.id,
        after: { name: created.name, slug: created.slug, promotionMode: data.promotionMode },
      },
    });
    return created;
  });

  // Branch + director + invitation — identical path a self-serve
  // registration takes once approved. Status is already ACTIVE, so this
  // is the "already ACTIVE" branch of approveOrganization's own idempotent
  // check, never re-running the PENDING->ACTIVE transition or its audit row.
  await approveOrganization(organization.slug, auth.context.actorUserId);

  return { ok: true };
}
