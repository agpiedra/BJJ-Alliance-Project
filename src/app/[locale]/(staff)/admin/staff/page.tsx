import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { prisma } from "@/lib/prisma";
import { listStaff } from "@/lib/staff/list-staff";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InviteForm, InvitationRowActions, LatestInvitationLink, MemberRowActions, StaffLinkProvider } from "./staff-forms";

// Staff change without a redeploy; never statically frozen.
export const dynamic = "force-dynamic";

/**
 * Staff management — the OWNER only. Nobody else may even see who works here or
 * how they are scoped, so the page demands `ADMIN` (a location director or an
 * instructor is redirected like any other unauthorized staff route); the real
 * enforcement is in `staff-actions.ts` on every write, which re-checks it.
 */
export default async function StaffPage() {
  const context = await requireTenantContext(["ADMIN"]);
  const t = await getTranslations("staffManagement");
  const tRole = await getTranslations("staffShell.userMenu.role");
  const locale = await getLocale();
  const branding = await getOrganizationBranding(context);

  const [{ members, invitations }, academies, organization] = await Promise.all([
    listStaff(context.organizationId),
    prisma.academy.findMany({ where: { organizationId: context.organizationId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { name: true, timezone: true } }),
  ]);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: organization.timezone });
  const academyNames = (list: { name: string }[], role: string) =>
    role === "ADMIN" ? t("allAcademies") : list.length === 0 ? "—" : list.map((academy) => academy.name).join(", ");

  return (
    <StaffLinkProvider>
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
          {t("eyebrow", { orgName: branding.displayName })}
        </p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("sub")}</p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("members.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">{t("columns.person")}</th>
                  <th className="pb-2 pr-4 font-medium">{t("columns.role")}</th>
                  <th className="pb-2 pr-4 font-medium">{t("columns.academies")}</th>
                  <th className="pb-2 pr-4 font-medium">{t("columns.status")}</th>
                  <th className="pb-2 font-medium">{t("columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.membershipId} className="border-t">
                    <td className="py-2 pr-4 align-top font-medium">
                      {member.email}
                      {member.userId === context.actorUserId && <span className="ml-1 font-normal text-muted-foreground">{t("you")}</span>}
                    </td>
                    <td className="py-2 pr-4 align-top">{tRole(member.role)}</td>
                    <td className="py-2 pr-4 align-top">{academyNames(member.academies, member.role)}</td>
                    <td className="py-2 pr-4 align-top">
                      <Badge variant="outline">{member.active ? t("status.active") : t("status.inactive")}</Badge>
                    </td>
                    <td className="py-2 align-top">
                      <MemberRowActions
                        organizationId={context.organizationId}
                        member={member}
                        academies={academies}
                        isSelf={member.userId === context.actorUserId}
                        organizationName={organization.name}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("invitations.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <LatestInvitationLink />
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("invitations.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{t("columns.person")}</th>
                    <th className="pb-2 pr-4 font-medium">{t("columns.role")}</th>
                    <th className="pb-2 pr-4 font-medium">{t("columns.academies")}</th>
                    <th className="pb-2 pr-4 font-medium">{t("columns.expires")}</th>
                    <th className="pb-2 font-medium">{t("columns.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id} className="border-t">
                      <td className="py-2 pr-4 align-top font-medium">{invitation.email}</td>
                      <td className="py-2 pr-4 align-top">{tRole(invitation.role)}</td>
                      <td className="py-2 pr-4 align-top">{academyNames(invitation.academies, invitation.role)}</td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {invitation.expired ? <Badge variant="outline">{t("invitations.expired")}</Badge> : dateFormat.format(invitation.expiresAt)}
                      </td>
                      <td className="py-2 align-top">
                        <InvitationRowActions organizationId={context.organizationId} invitation={invitation} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <InviteForm organizationId={context.organizationId} academies={academies} />
        </CardContent>
      </Card>
    </main>
    </StaffLinkProvider>
  );
}
