"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { resolveSuperAdminActionContext } from "@/lib/auth/require-super-admin";
import { flaggedFrom } from "@/lib/billing/deadline";
import type { ActionState } from "@/lib/action-state";

/**
 * deadline.ts reads every stored date back via
 * `DateTime.fromJSDate(date, { zone: organization.timezone })` — a calendar
 * date, not an instant. `new Date("2026-08-28")` parses as UTC midnight,
 * which is the PREVIOUS calendar day once converted into any timezone west
 * of UTC (every organization timezone this project seeds). Anchoring the
 * write to the same timezone the read uses is what keeps the two sides
 * agreeing on which day it is. Verified live: without this, a due date of
 * Aug 28 produced a computed deadline of Sep 1 instead of Sep 2 for a
 * Costa Rica organization.
 */
function parseCalendarDate(dateOnly: string, timezone: string): Date {
  return DateTime.fromISO(dateOnly, { zone: timezone }).startOf("day").toJSDate();
}

async function revalidateOrganizationDetail(organizationId: string): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/platform/organizations/${organizationId}`);
    revalidatePath(`/${locale}/platform/organizations`);
  } catch (error) {
    console.error("[platform/organizations/billing] failed to revalidate", { error });
  }
}

const nonNegativeInt = z.coerce.number().int().min(0);

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — "Platform invoices are
 * created manually by SUPER_ADMIN in v1... Creation snapshots the
 * organization's graceDays into graceDaysApplied." No scheduled job calls
 * this — verified by there being no cron/job file that does.
 *
 * Plain `z.object`, NOT `z.strictObject` — unlike the public registration
 * form's own item-1 correction, this form's action is bound
 * (`createInvoiceAction.bind(null, organizationId)`) for `useActionState`,
 * and Next's own Server Actions runtime injects its own hidden bound-
 * argument field into the submitted FormData. That field is the
 * framework's legitimate plumbing on an authenticated, SUPER_ADMIN-only
 * form — not an attacker-supplied field on an unauthenticated public
 * endpoint, which is what `z.strictObject` was protecting against there.
 * Verified directly: a real browser submission was silently rejected with
 * `z.strictObject` here (the unrecognized bound-argument key failed
 * validation) until this was changed.
 */
const createInvoiceSchema = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  dueOn: z.string().min(1),
  paidNote: z.string().max(500).optional(),
});

export async function createInvoiceAction(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const parsed = createInvoiceSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { graceDays: true, timezone: true } });
  if (!organization) return { error: "notFound" };

  await prisma.$transaction(async (tx) => {
    const created = await tx.organizationInvoice.create({
      data: {
        organizationId,
        periodStart: parseCalendarDate(parsed.data.periodStart, organization.timezone),
        periodEnd: parseCalendarDate(parsed.data.periodEnd, organization.timezone),
        dueOn: parseCalendarDate(parsed.data.dueOn, organization.timezone),
        graceDaysApplied: organization.graceDays,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organizationInvoice.create",
        entityType: "OrganizationInvoice",
        entityId: created.id,
        after: { dueOn: parsed.data.dueOn, graceDaysApplied: organization.graceDays },
      },
    });
  });

  await revalidateOrganizationDetail(organizationId);
  return { ok: true };
}

/**
 * "Recording payment sets paidAt and clears the banner and flag
 * immediately, audited with before/after values." `resolveDirectorBillingBanner`
 * re-reads `paidAt` live on every call, so "clears the banner immediately"
 * requires no separate step — the very next read already excludes this
 * invoice from `openInvoices`.
 */
export async function recordInvoicePaymentAction(invoiceId: string, paidNote: string | undefined): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const invoice = await prisma.organizationInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "notFound" };
  if (invoice.paidAt || invoice.voidedAt) return { error: "alreadyResolved" };

  await prisma.$transaction(async (tx) => {
    await tx.organizationInvoice.update({
      where: { id: invoiceId },
      data: { paidAt: new Date(), paidNote: paidNote || null, recordedById: auth.context.actorUserId },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId: invoice.organizationId,
        action: "organizationInvoice.recordPayment",
        entityType: "OrganizationInvoice",
        entityId: invoiceId,
        before: { paidAt: null },
        after: { paidAt: new Date().toISOString(), paidNote: paidNote || null },
      },
    });
  });

  await revalidateOrganizationDetail(invoice.organizationId);
  return { ok: true };
}

export async function voidInvoiceAction(invoiceId: string, voidReason: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };
  if (!voidReason.trim()) return { error: "reasonRequired" };

  const invoice = await prisma.organizationInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "notFound" };
  if (invoice.paidAt || invoice.voidedAt) return { error: "alreadyResolved" };

  await prisma.$transaction(async (tx) => {
    await tx.organizationInvoice.update({ where: { id: invoiceId }, data: { voidedAt: new Date(), voidReason } });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId: invoice.organizationId,
        action: "organizationInvoice.void",
        entityType: "OrganizationInvoice",
        entityId: invoiceId,
        before: { voidedAt: null },
        after: { voidedAt: new Date().toISOString(), voidReason },
      },
    });
  });

  await revalidateOrganizationDetail(invoice.organizationId);
  return { ok: true };
}

/**
 * "Acknowledgment is not resolution... leaves it GRACE_EXPIRED, unpaid."
 * This action writes ONLY the acknowledgment fields — never touches
 * `paidAt`/`voidedAt`/`status`. `reviewAcknowledgedForFlaggedOn` is set to
 * the CURRENT `flaggedFrom` at the moment of acknowledgment — see
 * deadline.ts's own `isUnreviewed` for why that specific value, not
 * `new Date()`, is what scopes this to one expiration episode.
 */
export async function acknowledgeInvoiceReviewAction(invoiceId: string, reviewNote: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };
  if (!reviewNote.trim()) return { error: "noteRequired" };

  const invoice = await prisma.organizationInvoice.findUnique({
    where: { id: invoiceId },
    include: { organization: { select: { timezone: true } } },
  });
  if (!invoice) return { error: "notFound" };

  const currentFlaggedFrom = flaggedFrom(invoice, invoice.organization.timezone).toJSDate();

  await prisma.$transaction(async (tx) => {
    await tx.organizationInvoice.update({
      where: { id: invoiceId },
      data: {
        reviewAcknowledgedAt: new Date(),
        reviewAcknowledgedById: auth.context.actorUserId,
        reviewNote,
        reviewAcknowledgedForFlaggedOn: currentFlaggedFrom,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId: invoice.organizationId,
        action: "organizationInvoice.acknowledgeReview",
        entityType: "OrganizationInvoice",
        entityId: invoiceId,
        after: { reviewNote, reviewAcknowledgedForFlaggedOn: currentFlaggedFrom.toISOString() },
      },
    });
  });

  await revalidateOrganizationDetail(invoice.organizationId);
  return { ok: true };
}

/**
 * "To move an outstanding invoice's deadline, use the explicit per-invoice
 * extension." A required note, matching graceDays's own change requirement.
 */
export async function extendInvoiceGraceAction(invoiceId: string, extensionDaysRaw: string, note: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };
  if (!note.trim()) return { error: "noteRequired" };

  const parsedExtension = nonNegativeInt.safeParse(extensionDaysRaw);
  if (!parsedExtension.success) return { error: "invalidExtension" };

  const invoice = await prisma.organizationInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "notFound" };
  if (invoice.paidAt || invoice.voidedAt) return { error: "alreadyResolved" };

  await prisma.$transaction(async (tx) => {
    await tx.organizationInvoice.update({
      where: { id: invoiceId },
      data: { graceExtensionDays: parsedExtension.data },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId: invoice.organizationId,
        action: "organizationInvoice.graceExtended",
        entityType: "OrganizationInvoice",
        entityId: invoiceId,
        before: { graceExtensionDays: invoice.graceExtensionDays },
        after: { graceExtensionDays: parsedExtension.data, note },
      },
    });
  });

  await revalidateOrganizationDetail(invoice.organizationId);
  return { ok: true };
}

/**
 * "Organization.graceDays is editable by SUPER_ADMIN only... Changing it
 * affects only invoices issued after the change." No invoice write here at
 * all — `graceDaysApplied` on every EXISTING invoice is untouched, by
 * construction (this action never reaches OrganizationInvoice).
 */
export async function updateOrganizationGraceDaysAction(organizationId: string, graceDaysRaw: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const parsed = nonNegativeInt.safeParse(graceDaysRaw);
  if (!parsed.success) return { error: "invalidGraceDays" };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { graceDays: true } });
  if (!organization) return { error: "notFound" };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: organizationId }, data: { graceDays: parsed.data } });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organization.graceDays.changed",
        entityType: "Organization",
        entityId: organizationId,
        before: { graceDays: organization.graceDays },
        after: { graceDays: parsed.data },
      },
    });
  });

  await revalidateOrganizationDetail(organizationId);
  return { ok: true };
}
