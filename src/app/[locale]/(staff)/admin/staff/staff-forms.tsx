"use client";

import { createContext, useActionState, useContext, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
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

export interface IssuedLink {
  email: string;
  link: string;
  emailSent: boolean;
}

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

export function LatestInvitationLink() {
  const { issued } = useContext(IssuedLinkContext);
  if (!issued) return null;
  return <InvitationLinkPanel key={issued.link} issued={issued} />;
}

/** The invitation link, always shown so it can be copied when the email never arrives. */
function InvitationLinkPanel({ issued }: { issued: IssuedLink }) {
  const t = useTranslations("staffManagement");
  const [copied, setCopied] = useState(false);
  const { link, emailSent, email } = issued;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the link stays selectable in the field below.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="invitation-link-panel">
      <p className={emailSent ? "text-sm text-ok" : "text-sm text-warn"}>{emailSent ? t("link.emailSent") : t("link.emailNotSent")}</p>
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
      if (result.invitationLink) {
        setIssued({ email: String(formData.get("email") ?? "").trim().toLowerCase(), link: result.invitationLink, emailSent: Boolean(result.emailSent) });
      }
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

/** One pending invitation's actions. A resend hands back a NEW link (the old one dies), shown to copy. */
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
      else if (result.invitationLink) setIssued({ email: invitation.email, link: result.invitationLink, emailSent: Boolean(result.emailSent) });
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
