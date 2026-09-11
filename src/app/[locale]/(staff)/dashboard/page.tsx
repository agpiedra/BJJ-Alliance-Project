import { getLocale, getTranslations } from "next-intl/server";
import { academyScopeWhere, requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import {
  listApproachingStudents,
  listPromotionQueue,
  type PromotionCandidate,
} from "@/lib/students/promotion-queue";
import { listOverdueStudents, type OverdueStudent } from "@/lib/payments/list-overdue";
import { formatMonthYear } from "@/lib/format-month";
import { ConfirmPromotionButton } from "./confirm-promotion-button";
import { PromotionStatusLabel } from "./promotion-status-label";

/**
 * `lastPaidMonth` comes back from `listOverdueStudents` as a plain,
 * locale-independent `"YYYY-MM"` string (see that module's doc comment) —
 * this page owns turning it into a localized month name, the same
 * responsibility split `students/[id]/page.tsx`'s own `formatPeriodMonth`
 * establishes for payment-period display. Both delegate the actual
 * formatting to the shared `formatMonthYear` (`@/lib/format-month`), which is
 * what pins the `timeZone: "UTC"` fix for this synthetic year/month marker.
 */
function formatLastPaidMonth(value: string, locale: string): string {
  const [year, month] = value.split("-").map(Number);
  return formatMonthYear(year, month, locale);
}

// Same reasoning as the roster page: the pending-approvals count is staff
// data that can change without a redeploy, so this page must never be
// statically frozen at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const staffSession = await requireStaffSession();
  const t = await getTranslations("dashboard");
  const locale = await getLocale();

  // academyScopeWhere(session) returns a fragment keyed `academyId`, but
  // Student's tenancy column is `homeAcademyId` — spreading the fragment
  // directly would throw a Prisma validation error for any non-ADMIN
  // session (confirmed while manually verifying this task). Translate it
  // the same way src/app/[locale]/(staff)/students/actions.ts's listStudents does,
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

  // Payments-overdue panel (spec §4.3) has no INSTRUCTOR-visible variant at
  // all — unlike the promotion queue below, which INSTRUCTOR can view
  // read-only. Checked here, before the query even runs, so an INSTRUCTOR
  // session never executes a query whose result would just be thrown away;
  // `listOverdueStudents` also self-enforces this same gate against
  // `staffSession.role`, so this is belt-and-suspenders, not the only check.
  const canViewOverduePayments = staffSession.role === "ADMIN" || staffSession.role === "DIRECTOR";

  // Both promotion queries scope by academyScopeWhere internally (see
  // promotion-queue.ts) the same way pendingCount does above — a
  // DIRECTOR/INSTRUCTOR only ever sees their own academy/academies here too.
  const [promotionQueue, approachingStudents, overdueStudents] = await Promise.all([
    listPromotionQueue(staffSession),
    listApproachingStudents(staffSession),
    canViewOverduePayments ? listOverdueStudents(staffSession) : Promise.resolve<OverdueStudent[]>([]),
  ]);

  // Confirming a promotion is ADMIN/DIRECTOR only (spec §3 excludes
  // INSTRUCTOR from promotions, same restriction confirmPromotion enforces
  // server-side) — mirrors student detail page's `canEdit` gate. INSTRUCTOR
  // sessions still see both lists in full, just without the button.
  const canConfirmPromotion = staffSession.role === "ADMIN" || staffSession.role === "DIRECTOR";

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p>
        {t("pendingApprovals", { count: pendingCount })}{" "}
        <a href={`/${locale}/students?status=PENDING`} className="underline">
          {t("pendingApprovalsLink")}
        </a>
      </p>

      {/* Director analytics (Phase 7): ADMIN/DIRECTOR only, same
          `canViewOverduePayments`-style conditional this page already
          established — the real enforcement is the analytics page's own
          `requireStaffSession(["ADMIN", "DIRECTOR"])` plus every query
          function's self-enforced role gate; this only avoids showing a
          link an INSTRUCTOR session would just be redirected/rejected from. */}
      {canViewOverduePayments && (
        <p>
          <a href={`/${locale}/dashboard/analytics`} className="underline">
            {t("analyticsLink")}
          </a>
        </p>
      )}

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
                      <PromotionStatusLabel status={candidate.status} />
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

      {/* Payments overdue (spec §4.3): ADMIN/DIRECTOR only, informational —
          no confirm/action button, since recording a payment happens on the
          student detail page (Task 2). Never rendered for an INSTRUCTOR
          session; canViewOverduePayments gates both the query above and this
          markup, so `overdueStudents` is always `[]` for that role anyway. */}
      {canViewOverduePayments && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">{t("overduePayments.heading")}</h2>
          {overdueStudents.length === 0 ? (
            <p className="text-muted-foreground">{t("overduePayments.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-4">{t("overduePayments.columns.name")}</th>
                    <th className="py-2 pr-4">{t("overduePayments.columns.academy")}</th>
                    <th className="py-2 pr-4">{t("overduePayments.columns.lastPaidMonth")}</th>
                  </tr>
                </thead>
                <tbody>
                  {overdueStudents.map((student: OverdueStudent) => (
                    <tr key={student.studentId} className="border-b">
                      <td className="py-2 pr-4">
                        {student.firstName} {student.lastName}
                      </td>
                      <td className="py-2 pr-4">{student.homeAcademyName}</td>
                      <td className="py-2 pr-4">
                        {student.lastPaidMonth
                          ? formatLastPaidMonth(student.lastPaidMonth, locale)
                          : t("overduePayments.neverPaid")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

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
