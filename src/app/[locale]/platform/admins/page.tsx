import { getTranslations } from "next-intl/server";
import { listPlatformAdmins } from "@/lib/tenant/platform-lookups";
import { Card, CardContent } from "@/components/ui/card";
import { GrantAdminForm } from "./grant-admin-form";
import { RevokeAdminButton } from "./revoke-admin-button";
import { requireSuperAdmin } from "@/lib/auth/require-super-admin";

export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — `isSuperAdmin` had exactly one
 * seeded holder and no UI at all before this. Lists every current holder
 * and lets an existing platform admin grant/revoke the flag on another
 * user. `currentActorId` is threaded down so the row for the acting admin
 * themselves never renders a revoke button — self-revocation is disallowed
 * server-side too (`admins/actions.ts`), but not offering the button at all
 * is the honest UI for a refusal that's never going to succeed.
 */
export default async function PlatformAdminsPage() {
  const { actorUserId } = await requireSuperAdmin();
  const t = await getTranslations("platform.admins");

  const admins = await listPlatformAdmins();

  return (
    <>
      <header>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("grant.heading")}</h2>
          <GrantAdminForm />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("list.heading", { count: admins.length })}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {admins.map((admin) => (
              <li key={admin.id} className="flex items-center justify-between gap-2">
                <span>
                  {admin.email} {!admin.active && `(${t("list.inactive")})`}
                </span>
                {admin.id !== actorUserId && admins.length > 1 && <RevokeAdminButton userId={admin.id} />}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
