"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { resolveActionContext } from "@/lib/tenant/context";
import { isValidHexColor, validateSidebarOverrides } from "@/lib/theme";
import { validateAndReencodeLogo, ACCEPTED_MIME_TYPES } from "@/lib/branding/validate-logo";
import { uploadLogo, deleteLogoByUrl } from "@/lib/branding/logo-storage";
import { revalidateBranding } from "@/lib/branding/get-branding";
import { Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const hex = () => z.string().refine(isValidHexColor, "invalidColor");
const optionalHex = () =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isValidHexColor(v), "invalidColor");

const themeSchema = z.object({
  displayName: z.string().trim().max(200).optional(),
  primaryColor: hex(),
  sidebarBackground: hex(),
  sidebarForeground: optionalHex(),
  sidebarActiveBackground: optionalHex(),
  sidebarActiveForeground: optionalHex(),
  sidebarBorder: optionalHex(),
});

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — ADMIN/DIRECTOR, matching the
 * doc's own "Configuración → Academia (org ADMIN/DIRECTOR only)" for the
 * settings page in general. Only the LOGO actions below are narrowed to
 * ADMIN-only, per this phase's explicit item 2 ruling.
 *
 * The sidebar's "block, don't warn" rule is enforced HERE, server-side,
 * before anything is written — `validateSidebarOverrides` is the same
 * function the client-side live preview calls for its own instant verdict,
 * so a director sees the same failure before hitting save, never only as a
 * rejection afterward (item 4).
 */
export async function saveBrandingTheme(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = themeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const sidebarCheck = validateSidebarOverrides({
    background: data.sidebarBackground,
    foreground: data.sidebarForeground ?? null,
    activeBackground: data.sidebarActiveBackground ?? null,
    activeForeground: data.sidebarActiveForeground ?? null,
    activeBackgroundDefault: data.primaryColor,
  });
  if (!sidebarCheck.ok) {
    const fieldErrors: Record<string, string[]> = {};
    for (const failure of sidebarCheck.failures) {
      fieldErrors[failure.field] = [`Fails WCAG AA (${failure.ratio.toFixed(2)}:1) — try ${failure.suggestion}`];
    }
    return { error: "sidebarContrast", fieldErrors };
  }

  const before = await getScopedDb(context).organizationBranding.findUnique({
    where: { organizationId: context.organizationId },
  });

  await prisma.$transaction(async (tx) => {
    await tx.organizationBranding.upsert({
      where: { organizationId: context.organizationId },
      create: {
        organizationId: context.organizationId,
        displayName: data.displayName || null,
        primaryColor: data.primaryColor,
        sidebarBackground: data.sidebarBackground,
        sidebarForeground: data.sidebarForeground ?? null,
        sidebarActiveBackground: data.sidebarActiveBackground ?? null,
        sidebarActiveForeground: data.sidebarActiveForeground ?? null,
        sidebarBorder: data.sidebarBorder ?? null,
      },
      update: {
        displayName: data.displayName || null,
        primaryColor: data.primaryColor,
        sidebarBackground: data.sidebarBackground,
        sidebarForeground: data.sidebarForeground ?? null,
        sidebarActiveBackground: data.sidebarActiveBackground ?? null,
        sidebarActiveForeground: data.sidebarActiveForeground ?? null,
        sidebarBorder: data.sidebarBorder ?? null,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: null,
        action: "organizationBranding.updateTheme",
        entityType: "OrganizationBranding",
        entityId: context.organizationId,
        before: before ? (before as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        after: data as unknown as Prisma.InputJsonValue,
      },
    });
  });

  revalidateBranding(context.organizationId);
  return { ok: true };
}

/**
 * Item 2: "this is the first endpoint in the app that accepts a file" —
 * rate-limited the same way the kiosk's own attempt limiter is: an atomic
 * count-then-decide gate, scaled down to this endpoint's actual threat
 * model (a handful of authenticated ADMINs iterating on their own logo, not
 * an unauthenticated shared tablet under brute-force). Reuses AuditLog
 * (every upload is already audited per item 3) rather than a second
 * dedicated rate-limit table.
 */
const LOGO_UPLOAD_WINDOW_MINUTES = 10;
const LOGO_UPLOAD_MAX_PER_WINDOW = 10;

async function isLogoUploadRateLimited(actorUserId: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - LOGO_UPLOAD_WINDOW_MINUTES * 60 * 1000);
  const count = await prisma.auditLog.count({
    where: { actorId: actorUserId, action: "organizationBranding.logoUpload", createdAt: { gte: windowStart } },
  });
  return count >= LOGO_UPLOAD_MAX_PER_WINDOW;
}

/**
 * ADMIN only (item 2) — enforced here, not by hiding the upload button;
 * the settings page still shows the control to a DIRECTOR (who can see
 * everything else on this page), but submitting it lands here and is
 * refused.
 *
 * Upload -> DB write -> delete-old-object, in that exact order (item 1):
 * deleting the old object FIRST would leave a committed row pointing at a
 * deleted file the instant the new upload or DB write failed. Deleting it
 * only after the new row has committed means the worst failure mode is an
 * orphaned object in storage — a leak, never a broken reference.
 */
export async function uploadBrandingLogo(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  if (await isLogoUploadRateLimited(context.actorUserId)) {
    return { error: "rateLimited" };
  }

  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "invalid", fieldErrors: { logo: ["required"] } };
  }
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { error: "invalidFormat" };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const validated = await validateAndReencodeLogo(bytes, file.type);
  if (!validated.ok) {
    return { error: validated.error };
  }

  const before = await getScopedDb(context).organizationBranding.findUnique({
    where: { organizationId: context.organizationId },
    select: { logoUrl: true },
  });

  const uploaded = await uploadLogo(context.organizationId, validated.result.bytes, validated.result.mimeType);
  const uploadedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.organizationBranding.upsert({
      where: { organizationId: context.organizationId },
      create: {
        organizationId: context.organizationId,
        logoUrl: uploaded.url,
        logoMimeType: validated.result.mimeType,
        logoUpdatedAt: uploadedAt,
      },
      update: { logoUrl: uploaded.url, logoMimeType: validated.result.mimeType, logoUpdatedAt: uploadedAt },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: null,
        action: "organizationBranding.logoUpload",
        entityType: "OrganizationBranding",
        entityId: context.organizationId,
        before: before?.logoUrl ? { logoUrl: before.logoUrl } : Prisma.DbNull,
        after: { logoUrl: uploaded.url },
      },
    });
  });

  // Only after the new row has committed — see this function's own doc
  // comment for why the ordering matters.
  if (before?.logoUrl) {
    await deleteLogoByUrl(before.logoUrl);
  }

  revalidateBranding(context.organizationId);
  return { ok: true };
}

/** ADMIN only, same risk profile as upload (item 2). "A director must be
 * able to delete a logo and return to the initials fallback" (item 1). */
export async function removeBrandingLogo(
  organizationId: string,
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const before = await getScopedDb(context).organizationBranding.findUnique({
    where: { organizationId: context.organizationId },
    select: { logoUrl: true },
  });
  if (!before?.logoUrl) {
    return { ok: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.organizationBranding.update({
      where: { organizationId: context.organizationId },
      data: { logoUrl: null, logoMimeType: null, logoUpdatedAt: null },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: null,
        action: "organizationBranding.logoRemove",
        entityType: "OrganizationBranding",
        entityId: context.organizationId,
        before: { logoUrl: before.logoUrl },
        after: Prisma.DbNull,
      },
    });
  });

  await deleteLogoByUrl(before.logoUrl);
  revalidateBranding(context.organizationId);
  return { ok: true };
}
