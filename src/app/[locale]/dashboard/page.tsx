import { getLocale, getTranslations } from "next-intl/server";
import { academyScopeWhere, requireStaffSession } from "@/lib/auth/session";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Same reasoning as the roster page: the pending-approvals count is staff
// data that can change without a redeploy, so this page must never be
// statically frozen at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const staffSession = await requireStaffSession();
  const session = await auth();
  const t = await getTranslations("dashboard");
  const locale = await getLocale();

  // academyScopeWhere(session) returns a fragment keyed `academyId`, but
  // Student's tenancy column is `homeAcademyId` — spreading the fragment
  // directly would throw a Prisma validation error for any non-ADMIN
  // session (confirmed while manually verifying this task). Translate it
  // the same way src/app/[locale]/students/actions.ts's listStudents does,
  // so a DIRECTOR/INSTRUCTOR only ever sees the pending count for their own
  // academy/academies — never a global count — and ADMIN (whose scope
  // fragment is `{}`) sees every pending student.
  const scope = academyScopeWhere(staffSession);
  const pendingCount = await prisma.student.count({
    where: {
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
      status: "PENDING",
    },
  });

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p>{t("welcome", { email: session?.user?.email ?? "" })}</p>
      <p>
        {t("pendingApprovals", { count: pendingCount })}{" "}
        <a href={`/${locale}/students?status=PENDING`} className="underline">
          {t("pendingApprovalsLink")}
        </a>
      </p>

      {/* /admin/kiosk-tokens and /admin/schedule were both fully built but
          reachable only by typing the URL. Shown to ADMIN sessions only,
          matching each page's own `requireStaffSession(["ADMIN"])` gate —
          this is navigation convenience, not the access control. Plain <a>
          + `/${locale}/…` is this app's existing link convention (see the
          pending-students link above); there is no shared nav shell yet. */}
      {staffSession.role === "ADMIN" && (
        <nav className="flex flex-col gap-2">
          <h2 className="font-medium">{t("adminSection")}</h2>
          <a href={`/${locale}/admin/kiosk-tokens`} className="underline">
            {t("adminKioskTokensLink")}
          </a>
          <a href={`/${locale}/admin/schedule`} className="underline">
            {t("adminScheduleLink")}
          </a>
        </nav>
      )}
    </main>
  );
}
