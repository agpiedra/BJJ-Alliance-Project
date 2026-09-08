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
    </main>
  );
}
