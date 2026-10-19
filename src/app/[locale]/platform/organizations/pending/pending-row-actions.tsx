"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InvitationReport } from "@/lib/organizations/invitation-feedback";
import { InvitationFeedbackNotice } from "../invitation-feedback-notice";
import { approveOrganizationAction, rejectOrganizationAction } from "../actions";

interface Approval {
  organizationId: string;
  organizationName: string;
  report: InvitationReport;
}

const ApprovalContext = createContext<{ approval: Approval | null; setApproval: (approval: Approval) => void }>({
  approval: null,
  setApproval: () => {},
});

/**
 * ONE place for the latest approval's outcome on the page. An approved organization leaves the pending queue, so the
 * refresh that follows unmounts its row — a message held in the row's own state would vanish with it.
 */
export function ApprovalFeedbackProvider({ children }: { children: ReactNode }) {
  const [approval, setApproval] = useState<Approval | null>(null);
  return <ApprovalContext.Provider value={{ approval, setApproval }}>{children}</ApprovalContext.Provider>;
}

export function LatestApprovalFeedback() {
  const { approval } = useContext(ApprovalContext);
  if (!approval) return null;
  return (
    <InvitationFeedbackNotice
      key={approval.organizationId}
      operation="approved"
      organizationId={approval.organizationId}
      organizationName={approval.organizationName}
      report={approval.report}
    />
  );
}

export function PendingRowActions({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const t = useTranslations("platform.organizations.pending.rowActions");
  const [isPending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { setApproval } = useContext(ApprovalContext);

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approveOrganizationAction(organizationId);
      if (result.error) setError(result.error);
      // Approved — whatever happened to the email. The outcome is reported beside it, never as a failed approval.
      else if (result.ok) {
        setApproval({
          organizationId,
          organizationName,
          report: { invitationEmail: result.invitationEmail, invitationSettlement: result.invitationSettlement },
        });
      }
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectOrganizationAction(organizationId, note);
      if (result.error) setError(result.error);
    });
  }

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("rejectNotePlaceholder")}
          disabled={isPending}
        />
        {error && <p className="text-sm text-destructive">{t(error as "noteRequired")}</p>}
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" disabled={isPending} onClick={handleReject}>
            {t("confirmReject")}
          </Button>
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setRejecting(false)}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 pt-2">
      <Button size="sm" disabled={isPending} onClick={handleApprove}>
        {t("approve")}
      </Button>
      <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setRejecting(true)}>
        {t("reject")}
      </Button>
      {error && <p className="text-sm text-destructive self-center">{error}</p>}
    </div>
  );
}
