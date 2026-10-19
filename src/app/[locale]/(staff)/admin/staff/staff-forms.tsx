"use client";

import { createContext, useActionState, useContext, useState, useTransition, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { EmailSendOutcome } from "@/lib/email/provider-errors";
import type { StaffInvitationSettlement } from "@/lib/staff/staff-service";
import { Button } from "@/components/ui/button";
import {
  deactivateStaffMember,
  inviteStaff,
  reactivateStaffMember,
  resendInvitation,
  revokeInvitation,
  updateStaffMember,
  type StaffInviteState,
} from "@/lib/staff/staff-actions";
import type { PendingInvitationRow, StaffMemberRow } from "@/lib/staff/list-staff";
import { STAFF_ROLES, type StaffMembershipRole } from "@/lib/staff/staff-role";

const INITIAL_STATE: StaffInviteState = {};
const INPUT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export interface AcademyOption {
  id: string;
  name: string;
}

/** "Student only" takes staff access away and keeps the person's own training — offered when EDITING a member, never when inviting (an invitation makes someone staff). */
type EditableRole = StaffMembershipRole | "STUDENT";

function RoleSelect({
  value,
  onChange,
  allowStudentOnly = false,
}: {
  value: EditableRole;
  onChange: (role: EditableRole) => void;
  allowStudentOnly?: boolean;
}) {
  const t = useTranslations("staffManagement");
  const tRole = useTranslations("staffShell.userMenu.role");
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{t("fields.role")}</span>
      <select name="role" value={value} onChange={(event) => onChange(event.target.value as EditableRole)} className={INPUT}>
        {STAFF_ROLES.map((role) => (
          <option key={role} value={role}>
            {tRole(role)}
          </option>
        ))}
        {allowStudentOnly && <option value="STUDENT">{t("roleStudentOnly")}</option>}
      </select>
      <span className="text-xs text-muted-foreground">{t(`roleHint.${value}` as never)}</span>
    </label>
  );
}

/**
 * An Owner has every academy; anyone else needs at least one — so the choice is
 * only shown for them. CONTROLLED: React resets an uncontrolled form after every
 * action, including one that failed validation, which would throw away what the
 * Owner had just chosen.
 */
function AcademyCheckboxes({
  academies,
  selected,
  onChange,
}: {
  academies: AcademyOption[];
  selected: string[];
  onChange: (academyIds: string[]) => void;
}) {
  const t = useTranslations("staffManagement");
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1">{t("fields.academies")}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {academies.map((academy) => (
          <label key={academy.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              name="academyIds"
              value={academy.id}
              checked={selected.includes(academy.id)}
              onChange={(event) => onChange(event.target.checked ? [...selected, academy.id] : selected.filter((id) => id !== academy.id))}
            />
            <span>{academy.name}</span>
          </label>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">{t("fields.academiesHint")}</span>
    </fieldset>
  );
}

/** One issue or resend, as the action reported it (docs/STAFF_INVITATION_RESEND_PLAN.md §3). */
export interface IssuedLink {
  email: string;
  invitationId: string;
  /** Absent when settlement found the new invitation accepted or no longer usable. */
  link?: string;
  expiresAt: Date;
  emailOutcome: EmailSendOutcome;
  settlement: StaffInvitationSettlement;
  /** A resend says what it did to earlier links; a first invite has none. */
  resend: boolean;
}

function issuedFrom(result: StaffInviteState, email: string, resend: boolean): IssuedLink | null {
  if (!result.ok || !result.invitationId || !result.emailOutcome || !result.settlement || !result.expiresAt) return null;
  return {
    email,
    invitationId: result.invitationId,
    link: result.invitationLink,
    expiresAt: new Date(result.expiresAt),
    emailOutcome: result.emailOutcome,
    settlement: result.settlement,
    resend,
  };
}

const OUTCOME_KEY: Record<EmailSendOutcome, string> = {
  accepted: "link.outcome.accepted",
  rejected: "link.outcome.rejected",
  not_configured: "link.outcome.notConfigured",
  unknown: "link.outcome.unknown",
};

const IssuedLinkContext = createContext<{ issued: IssuedLink | null; setIssued: (issued: IssuedLink | null) => void }>({
  issued: null,
  setIssued: () => {},
});

/**
 * ONE place for the newest invitation link on the page. A resend replaces the
 * invitation (new id, the old link dies), and the refresh that follows unmounts
 * the row that triggered it — so a link held in that row's own state was lost,
 * while an earlier invite's panel went on showing a link that no longer worked.
 * Held here, a newer link always replaces an older one and cannot vanish.
 */
export function StaffLinkProvider({ children }: { children: ReactNode }) {
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  return <IssuedLinkContext.Provider value={{ issued, setIssued }}>{children}</IssuedLinkContext.Provider>;
}

/**
 * `usableIds`: the pending invitations that were NOT expired when the page rendered (the existing listStaff data). Every
 * staff action re-renders the page, so after a refresh a link whose invitation was accepted, revoked, replaced — or is
 * still listed but has expired — is hidden. Accurate as of the last render only; there is no polling.
 */
export function LatestInvitationLink({ usableIds }: { usableIds: string[] }) {
  const { issued } = useContext(IssuedLinkContext);
  // The list current when this result arrived. The result can render BEFORE the page refresh that lists the new
  // invitation (the action's state update lands outside the refresh's transition), so absence from THAT list proves
  // nothing; only a newer list — a real refresh — is re-checked. Until then, settlement's own check stands.
  const [arrivedWith, setArrivedWith] = useState<{ issued: IssuedLink | null; usableIds: string[] }>({ issued, usableIds });
  if (arrivedWith.issued !== issued) setArrivedWith({ issued, usableIds });
  if (!issued) return null;
  const refreshedSince = usableIds !== arrivedWith.usableIds;
  const stillUsable = issued.expiresAt.getTime() > Date.now() && (!refreshedSince || usableIds.includes(issued.invitationId));
  return <InvitationLinkPanel key={`${issued.invitationId}:${issued.link ?? ""}`} issued={issued} stillUsable={stillUsable} />;
}

/** The email outcome, what this resend did to earlier links, and the link — only while it may work, labelled for what is known. */
function InvitationLinkPanel({ issued, stillUsable }: { issued: IssuedLink; stillUsable: boolean }) {
  const t = useTranslations("staffManagement");
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const { link, email, emailOutcome, settlement, resend } = issued;
  const showLink = link !== undefined && stillUsable && (settlement === "settled" || settlement === "failed");
  const success = emailOutcome === "accepted" && settlement === "settled" && stillUsable;

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the link stays selectable in the field below.
      setCopied(false);
    }
  }

  let status: string;
  if (settlement === "acceptedMeanwhile") status = t("link.acceptedMeanwhile");
  else if (settlement === "unavailable") status = t("link.unavailable");
  else if (!stillUsable) status = t("link.noLongerUsable");
  else if (settlement === "failed") status = t("link.unverified");
  else {
    const expiresAt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(issued.expiresAt);
    status = t("link.checked", { expiresAt });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="invitation-link-panel">
      <p className={success ? "text-sm text-ok" : "text-sm text-warn"}>{t(OUTCOME_KEY[emailOutcome] as never)}</p>
      {/* What THIS resend did. Retiring happens only on a provider-accepted send that settled; in every other case
          (failed send, unusable new link, or a settle that rolled back) it invalidated nothing. */}
      {resend && <p className="text-sm">{t(emailOutcome === "accepted" && settlement === "settled" ? "link.resend.retired" : "link.resend.kept")}</p>}
      <p className={settlement === "settled" && stillUsable ? "text-xs text-muted-foreground" : "text-sm text-warn"} data-testid="invitation-link-status">
        {status}
      </p>
      {showLink && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span>
              {t("link.label")} · {email}
            </span>
            <input type="text" readOnly value={link} onFocus={(event) => event.currentTarget.select()} className={`${INPUT} font-mono text-xs`} />
          </label>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? t("link.copied") : t("link.copy")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("link.note")}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function InviteForm({ organizationId, academies }: { organizationId: string; academies: AcademyOption[] }) {
  const t = useTranslations("staffManagement");
  const [role, setRole] = useState<StaffMembershipRole>("INSTRUCTOR");
  const [email, setEmail] = useState("");
  const [academyIds, setAcademyIds] = useState<string[]>([]);
  const { setIssued } = useContext(IssuedLinkContext);
  // The fields are controlled so a REFUSED invitation (say, no location chosen)
  // keeps what was typed; only a successful one clears them for the next.
  const [state, formAction, isPending] = useActionState(async (previous: StaffInviteState, formData: FormData) => {
    const result = await inviteStaff(organizationId, previous, formData);
    if (result.ok) {
      const issued = issuedFrom(result, String(formData.get("email") ?? "").trim().toLowerCase(), false);
      if (issued) setIssued(issued);
      setEmail("");
      setAcademyIds([]);
    }
    return result;
  }, INITIAL_STATE);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("invite.heading")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.email")}</span>
            <input type="email" name="email" required maxLength={200} value={email} onChange={(event) => setEmail(event.target.value)} className={INPUT} />
          </label>
          <RoleSelect value={role} onChange={(next) => setRole(next as StaffMembershipRole)} />
        </div>
        {role !== "ADMIN" && <AcademyCheckboxes academies={academies} selected={academyIds} onChange={setAcademyIds} />}
        {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
        {state.ok && <p className="text-sm text-ok">{t("invite.success")}</p>}
        <div>
          <Button type="submit" disabled={isPending}>
            {t("invite.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function EditMemberForm({
  organizationId,
  member,
  academies,
  onDone,
}: {
  organizationId: string;
  member: StaffMemberRow;
  academies: AcademyOption[];
  onDone: () => void;
}) {
  const t = useTranslations("staffManagement");
  const [state, formAction, isPending] = useActionState(updateStaffMember.bind(null, organizationId), INITIAL_STATE);
  const [role, setRole] = useState<EditableRole>(member.role);
  const [academyIds, setAcademyIds] = useState<string[]>(member.academies.map((academy) => academy.id));

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <RoleSelect value={role} onChange={setRole} allowStudentOnly />
      {/* An Owner has every location and a student-only member has none — neither needs a choice. */}
      {(role === "DIRECTOR" || role === "INSTRUCTOR") && <AcademyCheckboxes academies={academies} selected={academyIds} onChange={setAcademyIds} />}
      {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("edit.success")}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {t("edit.save")}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("edit.close")}
        </Button>
      </div>
    </form>
  );
}

/** One member's actions: edit role and academies, deactivate / reactivate. Nobody manages themselves — the server refuses it too. */
export function MemberRowActions({
  organizationId,
  member,
  academies,
  isSelf,
  organizationName,
}: {
  organizationId: string;
  member: StaffMemberRow;
  academies: AcademyOption[];
  isSelf: boolean;
  organizationName: string;
}) {
  const t = useTranslations("staffManagement");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (isSelf) return <span className="text-xs text-muted-foreground">{t("selfNote")}</span>;

  function toggleActive() {
    if (member.active && !window.confirm(t("deactivate.confirm", { organization: organizationName }))) return;
    setError(null);
    startTransition(async () => {
      const result = member.active
        ? await deactivateStaffMember(organizationId, member.membershipId)
        : await reactivateStaffMember(organizationId, member.membershipId);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {t("edit.open")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={toggleActive} disabled={isPending}>
          {member.active ? t("deactivate.button") : t("reactivate.button")}
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{t(`error.${error}` as never)}</p>}
      {editing && <EditMemberForm organizationId={organizationId} member={member} academies={academies} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** One pending invitation's actions. A resend hands back a NEW link, shown to copy; earlier links are retired only once the provider accepts the email. Revoke withdraws every live link of the offer. */
export function InvitationRowActions({ organizationId, invitation }: { organizationId: string; invitation: PendingInvitationRow }) {
  const t = useTranslations("staffManagement");
  const [error, setError] = useState<string | null>(null);
  const { setIssued } = useContext(IssuedLinkContext);
  const [isPending, startTransition] = useTransition();

  function resend() {
    setError(null);
    startTransition(async () => {
      const result = await resendInvitation(organizationId, invitation.id);
      if (result.error) setError(result.error);
      else {
        const issued = issuedFrom(result, invitation.email, true);
        if (issued) setIssued(issued);
      }
    });
  }

  function revoke() {
    if (!window.confirm(t("revoke.confirm"))) return;
    setError(null);
    startTransition(async () => {
      const result = await revokeInvitation(organizationId, invitation.id);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={resend} disabled={isPending}>
          {t("resend.button")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={revoke} disabled={isPending}>
          {t("revoke.button")}
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{t(`error.${error}` as never)}</p>}
    </div>
  );
}
