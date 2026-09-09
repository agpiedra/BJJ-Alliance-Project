import { getLocale, getTranslations } from "next-intl/server";
import { academyScopeWhere, requireStaffSession } from "@/lib/auth/session";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import {
  listApproachingStudents,
  listPromotionQueue,
  type PromotionCandidate,
} from "@/lib/students/promotion-queue";
import { ConfirmPromotionButton } from "./confirm-promotion-button";

// Maps PromotionCandidate.status ("stripe-eligible" | "exam-eligible" |
// "approaching") to its message key under dashboard.promotionQueue.status —
// only the first two are ever rendered (the queue section filters
// "approaching" out; the Approaching section below doesn't show a status
// column at all, since every row in it shares the same status).
const QUEUE_STATUS_KEY: Record<"stripe-eligible" | "exam-eligible", string> = {
  "stripe-eligible": "promotionQueue.status.stripe-eligible",
  "exam-eligible": "promotionQueue.status.exam-eligible",
};

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

  // Both queries scope by academyScopeWhere internally (see
  // promotion-queue.ts) the same way pendingCount does above — a
  // DIRECTOR/INSTRUCTOR only ever sees their own academy/academies here too.
  const [promotionQueue, approachingStudents] = await Promise.all([
    listPromotionQueue(staffSession),
    listApproachingStudents(staffSession),
  ]);

  // Confirming a promotion is ADMIN/DIRECTOR only (spec §3 excludes
  // INSTRUCTOR from promotions, same restriction confirmPromotion enforces
  // server-side) — mirrors student detail page's `canEdit` gate. INSTRUCTOR
  // sessions still see both lists in full, just without the button.
  const canConfirmPromotion = staffSession.role === "ADMIN" || staffSession.role === "DIRECTOR";

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

      {/* Promotion queue: students at a stripe threshold or exam threshold
          (spec §4.3). Every staff role sees the full list — INSTRUCTOR
          included, since spec §3 only excludes them from actually
          confirming, not from viewing eligibility — the confirm button
          itself is gated below by `canConfirmPromotion`, not the row. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{t("promotionQueue.heading")}</h2>
        {promotionQueue.length === 0 ? (
          <p className="text-muted-foreground">{t("promotionQueue.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4">{t("promotionQueue.columns.name")}</th>
                  <th className="py-2 pr-4">{t("promotionQueue.columns.belt")}</th>
                  <th className="py-2 pr-4">{t("promotionQueue.columns.academy")}</th>
                  <th className="py-2 pr-4">{t("promotionQueue.columns.status")}</th>
                  <th className="py-2 pr-4">{t("promotionQueue.columns.atBeltCount")}</th>
                  {canConfirmPromotion && (
                    <th className="py-2 pr-4">
                      <span className="sr-only">{t("promotionQueue.columns.actions")}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {promotionQueue.map((candidate: PromotionCandidate) => (
                  <tr key={candidate.studentId} className="border-b">
                    <td className="py-2 pr-4">
                      {candidate.firstName} {candidate.lastName}
                    </td>
                    <td className="py-2 pr-4">
                      <BeltGraphic belt={candidate.currentBelt} stripes={candidate.currentStripes} />
                    </td>
                    <td className="py-2 pr-4">{candidate.homeAcademyName}</td>
                    <td className="py-2 pr-4">
                      {t(
                        QUEUE_STATUS_KEY[candidate.status as "stripe-eligible" | "exam-eligible"],
                      )}
                    </td>
                    <td className="py-2 pr-4">{candidate.atBeltCount}</td>
                    {/* Server-side gate is the real enforcement
                        (confirmPromotion re-checks role + scope) — this only
                        avoids showing a control to a role that would just be
                        rejected, as defense in depth (same convention as
                        student detail page's canEdit-gated buttons). */}
                    {canConfirmPromotion && (
                      <td className="py-2 pr-4">
                        <ConfirmPromotionButton studentId={candidate.studentId} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Approaching: students getting close to a stripe threshold but not
          there yet (spec §4.3). No confirm button ever, for anyone —
          resolvePromotionTarget would reject every row here, so a button
          that always fails is never offered. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{t("approaching.heading")}</h2>
        {approachingStudents.length === 0 ? (
          <p className="text-muted-foreground">{t("approaching.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4">{t("approaching.columns.name")}</th>
                  <th className="py-2 pr-4">{t("approaching.columns.belt")}</th>
                  <th className="py-2 pr-4">{t("approaching.columns.academy")}</th>
                  <th className="py-2 pr-4">{t("approaching.columns.remainingToNextStripe")}</th>
                </tr>
              </thead>
              <tbody>
                {approachingStudents.map((candidate: PromotionCandidate) => (
                  <tr key={candidate.studentId} className="border-b">
                    <td className="py-2 pr-4">
                      {candidate.firstName} {candidate.lastName}
                    </td>
                    <td className="py-2 pr-4">
                      <BeltGraphic belt={candidate.currentBelt} stripes={candidate.currentStripes} />
                    </td>
                    <td className="py-2 pr-4">{candidate.homeAcademyName}</td>
                    <td className="py-2 pr-4">{candidate.remainingToNextStripe ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
