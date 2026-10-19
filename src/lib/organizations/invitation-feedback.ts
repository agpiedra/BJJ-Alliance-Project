import type { EmailSendOutcome } from "@/lib/email/provider-errors";
import type { ApproveOrganizationResult, InvitationSettlement } from "@/lib/organizations/approve-organization";

/**
 * What the platform panel reports about the owner's invitation after an organization is approved or created —
 * built ONLY from what approveOrganization() already returns (the email outcome classified in
 * send-transactional-email.ts, and what invitation settlement found). No second classification.
 *
 * Import-free at runtime (types only), so the same mapping serves server pages and client components.
 */
export type InvitationEmailReport = EmailSendOutcome | "notIssued" | "legacyUnresolved";

export interface InvitationReport {
  invitationEmail?: InvitationEmailReport;
  invitationSettlement?: InvitationSettlement;
}

/** The approve action's existing mapping, shared with the New organization action. */
export function invitationReportOf(
  result: Pick<ApproveOrganizationResult, "invitationIssue" | "invitationEmailOutcome" | "invitationSettlement">,
): InvitationReport {
  // "notIssued": an invitation to this address was genuinely accepted (`acceptedAt`). "legacyUnresolved": a row
  // consumed under the old rules — accepted or superseded, unknowable — blocks a new one until an operator resolves it.
  if (result.invitationIssue === "alreadyAccepted") return { invitationEmail: "notIssued" };
  if (result.invitationIssue === "legacyUnresolved") return { invitationEmail: "legacyUnresolved" };
  return { invitationEmail: result.invitationEmailOutcome ?? undefined, invitationSettlement: result.invitationSettlement ?? undefined };
}

const EMAIL_REPORTS: readonly InvitationEmailReport[] = ["accepted", "rejected", "not_configured", "unknown", "notIssued", "legacyUnresolved"];
const SETTLEMENTS: readonly InvitationSettlement[] = ["settled", "acceptedMeanwhile", "unavailable", "failed"];

/** The copy for one report, as message keys under `platform.organizations.invitationFeedback`. */
export interface InvitationFeedbackCopy {
  email: string;
  /** What settlement found, when it adds something; absent for a provider-accepted send that settled. */
  settlement?: string;
  /** The operator should act (the owner may have no working invitation, or it is not known). */
  needsAttention: boolean;
}

/**
 * The organization itself is saved in every case. A first invitation has no earlier links, so — unlike a resend —
 * nothing here talks about them. The platform withdraws a new link whose email was rejected or unconfigured
 * (approve-organization.ts settleInvitation), so then the owner has no working invitation and the copy points to the
 * existing "Resend invitation" button — never to approving or creating again. No outcome promises a working link.
 */
export function invitationFeedbackCopy(report: InvitationReport): InvitationFeedbackCopy {
  const email = report.invitationEmail ?? "unknown";
  const copy: InvitationFeedbackCopy = { email: `email.${email}`, needsAttention: false };
  if (email === "notIssued") return copy;
  if (email === "legacyUnresolved") return { ...copy, needsAttention: true };

  switch (report.invitationSettlement) {
    case "acceptedMeanwhile":
      return { ...copy, settlement: "settlement.acceptedMeanwhile" };
    case "unavailable":
      return { ...copy, settlement: "settlement.unavailable", needsAttention: true };
    case "failed":
      return { ...copy, settlement: "settlement.failed", needsAttention: true };
    case "settled":
      if (email === "accepted") return copy;
      if (email === "unknown") return { ...copy, settlement: "settlement.unknownOpen" };
      return { ...copy, settlement: "settlement.withdrawn", needsAttention: true };
    default:
      // No settlement reported: nothing is claimed about the link.
      return { ...copy, needsAttention: email !== "accepted" };
  }
}

/** Carries a report across the New organization redirect (query parameters hold fixed values only). */
export function invitationReportQuery(organizationId: string, report: InvitationReport): string {
  const query = new URLSearchParams({ created: organizationId });
  if (report.invitationEmail) query.set("invitationEmail", report.invitationEmail);
  if (report.invitationSettlement) query.set("invitationSettlement", report.invitationSettlement);
  return query.toString();
}

/**
 * The list page's notice after New organization: only for an organization the page actually lists (the URL is
 * untrusted — an unknown id shows nothing), with the report read back through `parseInvitationReport`.
 */
export function createdOrganizationNotice<Organization extends { id: string }>(
  query: { created?: string; invitationEmail?: string; invitationSettlement?: string },
  organizations: Organization[],
): { organization: Organization; report: InvitationReport } | null {
  const organization = query.created ? organizations.find((candidate) => candidate.id === query.created) : undefined;
  return organization ? { organization, report: parseInvitationReport(query) } : null;
}

/** Reads it back. The URL is untrusted: anything outside the fixed values is dropped. */
export function parseInvitationReport(query: { invitationEmail?: string; invitationSettlement?: string }): InvitationReport {
  const email = EMAIL_REPORTS.find((value) => value === query.invitationEmail);
  const settlement = SETTLEMENTS.find((value) => value === query.invitationSettlement);
  return { invitationEmail: email, invitationSettlement: email ? settlement : undefined };
}
