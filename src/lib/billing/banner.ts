import { prisma } from "@/lib/prisma";
import { resolveInvoiceState, graceEndsOn, type InvoiceState } from "./deadline";
import type { AccessContext } from "@/lib/tenant/types";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — the ONLY shape a
 * director-facing surface is ever handed. Deliberately just these three
 * fields: no `graceDays`, no `graceDaysApplied`, no `graceExtensionDays`,
 * no invoice id, nothing from `OrganizationInvoice` beyond what's rendered.
 * "Not visible to directors" means omitted from the data, not hidden in
 * the UI — a route-handler response, a server-action return value, or an
 * RSC prop built from this type structurally cannot leak the grace number,
 * because it was never read past the point this function's own DB query
 * selects; assert this in tests against the actual serialized value, not
 * the rendered DOM.
 */
export interface DirectorBillingBanner {
  state: Extract<InvoiceState, "DUE" | "GRACE_EXPIRED">;
  dueOn: string; // ISO calendar date
  deadline: string; // ISO calendar date — graceEndsOn, the last day of grace
}

/**
 * `OrganizationInvoice` is not in `TENANT_SCOPED_MODELS` — every read here
 * is already scoped by the caller's OWN, already-validated
 * `context.organizationId` (never a client-supplied id), so this goes
 * through the plain guarded `prisma` client with an explicit
 * `organizationId` filter. There is nothing platform-level about a
 * director reading their own organization's billing state — unlike
 * `resolveOrganizationAuditTrail` (platform-lookups.ts), which genuinely
 * needs to read a DIFFERENT organization than the caller's own.
 */
export async function resolveDirectorBillingBanner(context: AccessContext): Promise<DirectorBillingBanner | null> {
  if (context.kind !== "tenant") return null;

  const organization = await prisma.organization.findUnique({
    where: { id: context.organizationId },
    select: { timezone: true },
  });
  if (!organization) return null;

  const openInvoices = await prisma.organizationInvoice.findMany({
    where: { organizationId: context.organizationId, paidAt: null, voidedAt: null },
    select: { dueOn: true, graceDaysApplied: true, graceExtensionDays: true, paidAt: true, voidedAt: true },
  });

  let mostUrgent: { state: InvoiceState; dueOn: Date; deadline: string } | null = null;
  for (const invoice of openInvoices) {
    const state = resolveInvoiceState(invoice, organization.timezone);
    if (state === "CURRENT") continue;
    // GRACE_EXPIRED outranks DUE — if any invoice is expired, that's the one worth surfacing.
    if (!mostUrgent || (state === "GRACE_EXPIRED" && mostUrgent.state === "DUE")) {
      mostUrgent = { state, dueOn: invoice.dueOn, deadline: graceEndsOn(invoice, organization.timezone).toISODate()! };
    }
  }

  if (!mostUrgent) return null;

  return {
    state: mostUrgent.state as Extract<InvoiceState, "DUE" | "GRACE_EXPIRED">,
    dueOn: mostUrgent.dueOn.toISOString().slice(0, 10),
    deadline: mostUrgent.deadline,
  };
}
