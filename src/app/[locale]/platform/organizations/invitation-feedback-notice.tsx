"use client";

import { useLocale, useTranslations } from "next-intl";
import { invitationFeedbackCopy, type InvitationReport } from "@/lib/organizations/invitation-feedback";

/**
 * After Approve or New organization: first that the organization operation succeeded, then — separately — what is
 * known about the owner's invitation email and what settlement found (lib/organizations/invitation-feedback.ts).
 * Never shows a link (the panel exposes none); points to the organization's page, where "Resend invitation" lives.
 */
export function InvitationFeedbackNotice({
  operation,
  organizationId,
  organizationName,
  report,
}: {
  operation: "approved" | "created";
  organizationId: string;
  organizationName: string;
  report: InvitationReport;
}) {
  const t = useTranslations("platform.organizations.invitationFeedback");
  const locale = useLocale();
  const copy = invitationFeedbackCopy(report);

  return (
    <div role="status" data-testid="invitation-feedback" className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{t(operation, { name: organizationName })}</p>
      <p className={copy.needsAttention ? "text-destructive" : "text-muted-foreground"} data-testid="invitation-feedback-email">
        {t(copy.email as never)}
        {copy.settlement && ` ${t(copy.settlement as never)}`}
      </p>
      <a href={`/${locale}/platform/organizations/${organizationId}`} className="w-fit underline">
        {t("openOrganization")}
      </a>
    </div>
  );
}
