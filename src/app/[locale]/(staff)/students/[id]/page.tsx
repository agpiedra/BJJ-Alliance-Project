import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { formatMonthYear } from "@/lib/format-month";
import { formatMoney } from "@/lib/payments/format-money";
import { listSelectablePlans } from "@/lib/payments/list-plans";
import { currentCrDateParts } from "@/lib/payments/get-current-period";
import { ensureCustomPromoPlan } from "@/lib/payments/ensure-custom-promo-plan";
import { getStudentForStaff } from "./get-student";
import { getPromotionHistory } from "./get-promotion-history";
import { getPromotionCreditHistory } from "./get-promotion-credit-history";
import { getPaymentHistory } from "./get-payment-history";
import { EditStudentForm } from "./edit-student-form";
import { ArchiveStudentButton } from "./archive-student-button";
import { RestoreStudentButton } from "./restore-student-button";
import { ApproveStudentButton } from "./approve-student-button";
import { RegenerateCodeButton } from "./regenerate-code-button";
import { AddAdjustmentForm } from "./add-adjustment-form";
import { RecordPaymentForm } from "@/components/payments/record-payment-form";
import { PromocionesCard, type PromocionesHistoryRow, type PromotionCreditHistoryRow } from "./promociones-card";
import { resolveDefaultTrackChangeRankId } from "@/lib/promotion/track-change";

// Staff data an admin/director/instructor could change without a redeploy —
// never frozen at build time, same reasoning as the roster page.
export const dynamic = "force-dynamic";

/**
 * A DATE-ONLY field (`dateOfBirth`) — no meaningful time component, so a
 * raw UTC slice is correct and a timezone conversion would be the bug:
 * Postgres hands back midnight UTC, and shifting that into UTC-6 would roll
 * it back to the previous day.
 */
function formatDateOnly(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const context = await requireTenantContext();
  const { locale, id } = await params;

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d: this staff route previously had
  // NO restriction limiting a STUDENT-role session to their own record —
  // `isAcademyInTenantScope` only checks branch scope, so any student could
  // load ANY other student's full profile (phone, email, payment history)
  // in the same academy by guessing/typing a URL. A real, pre-existing gap,
  // surfaced while implementing the Promociones card's own STUDENT row
  // ("their own progress only"). Same 404-not-forbidden discipline as the
  // out-of-scope case below — a student probing another student's id learns
  // nothing from the response shape.
  if (context.organizationRole === "STUDENT" && context.selfStudentId !== id) {
    notFound();
  }

  // getStudentForStaff returns null both when the id doesn't exist at all
  // and when it exists but is outside this session's organization/academy
  // scope — the page can't tell the two apart, and shouldn't: both render
  // as a plain 404, never a distinguishable "forbidden" that would confirm
  // a guessed id belongs to someone.
  const student = await getStudentForStaff(context, id);
  if (!student) {
    notFound();
  }

  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const summary = await getAtBeltSummary(student.id, context.organizationId, configByTrack);
  const promotionHistory = await getPromotionHistory(student.id, context.organizationId);
  const creditHistoryRaw = await getPromotionCreditHistory(student.id, context.organizationId, student.beltAwardedAt);
  const paymentHistory = await getPaymentHistory(student.id, context.organizationId);

  const t = await getTranslations("students");
  const tDetail = await getTranslations("students.detail");
  const tStatus = await getTranslations("students.status");
  const tPaymentStatus = await getTranslations("students.paymentStatus");

  // Edit/archive are gated to ADMIN/DIRECTOR in the UI as defense in depth —
  // the real gate is server-side in updateStudent/archiveStudent
  // (requireTenantContext(["ADMIN", "DIRECTOR"]) + a fresh isAcademyInTenantScope
  // check). Code regeneration has no role restriction (spec §4.1), so it's
  // shown to any staff session.
  const canEdit = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  // Promociones card: the manual-correction form's rank dropdown. Only
  // fetched for a session that can actually act (canEdit) — INSTRUCTOR/
  // STUDENT sessions never render the form at all, so this query would be
  // pure waste for them.
  const rankOptions = canEdit
    ? await prisma.beltRank.findMany({
        where: { organizationId: context.organizationId, track: student.track },
        orderBy: { order: "asc" },
        select: { id: true, code: true, order: true },
      })
    : [];

  // Phase 3c-ii: the track-change flow's destination is always the OTHER
  // track from the student's current one — fetched separately from
  // `rankOptions` above (which is scoped to the CURRENT track, for the
  // same-track correction form).
  const otherTrack = student.track === "ADULT" ? "KIDS" : "ADULT";
  const trackChangeRankOptions = canEdit
    ? await prisma.beltRank.findMany({
        where: { organizationId: context.organizationId, track: otherTrack },
        orderBy: { order: "asc" },
        select: { id: true, code: true, order: true, maxStripes: true, labelEs: true, labelEn: true },
      })
    : [];
  const defaultTrackChangeRankId = resolveDefaultTrackChangeRankId(
    student.track,
    student.currentRank.code,
    trackChangeRankOptions,
  );
  const studentAge = student.dateOfBirth
    ? Math.floor((Date.now() - student.dateOfBirth.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : null;
  const isTrackTransitionAge = student.track === "KIDS" && studentAge !== null && studentAge >= 16;

  // `recordPayment` re-checks ADMIN/DIRECTOR + plan-academy scope itself —
  // this fetch just avoids the extra query/render when the form won't be
  // shown at all (same `canEdit` gate as edit/archive above).
  //
  // `ensureCustomPromoPlan` (REDESIGN_BRIEF.md Phase 6 ruling #2) guarantees
  // this academy's custom-promotion plan row exists before the
  // shared `RecordPaymentForm` needs to offer it, same as the new
  // `/payments` route.
  if (canEdit) {
    await ensureCustomPromoPlan(context.organizationId, student.homeAcademyId);
  }
  const paymentPlans = canEdit ? await listSelectablePlans(context.organizationId, [student.homeAcademyId]) : [];
  // What a NEW payment on this page is recorded in; recorded ones keep their own.
  const { currency: organizationCurrency } = await prisma.organization.findUniqueOrThrow({
    where: { id: context.organizationId },
    select: { currency: true },
  });
  const { year: currentYear, month: currentMonth } = currentCrDateParts();

  function formatPeriodMonth(year: number, month: number): string {
    return formatMonthYear(year, month, locale);
  }

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d: MANUAL mode has no engine
  // target to show ("at the coach's discretion") — the card's own vocabulary
  // adds a fourth display-only value the engine itself never produces.
  const cardNextTarget = summary.mode === "MANUAL" ? "MANUAL_DISPLAY" : summary.nextTarget;
  const dueDateFormatted = formatTimestampInAcademyZone(summary.dueDate, locale);
  // Phase 3a rev 19: labels are per-organization data on the rank row —
  // resolved HERE (this page already has the viewer's locale) rather than
  // inside any client component, which never translates a code itself.
  const currentBeltLabel = locale === "es" ? student.currentRank.labelEs : student.currentRank.labelEn;
  const currentBeltVisual = {
    primaryColor: student.currentRank.primaryColor,
    centerStripeColor: student.currentRank.centerStripeColor,
    barColor: student.currentRank.barColor,
    stripeColors: student.currentRank.stripeColors,
    maxStripes: student.currentRank.maxStripes,
    visibleStripeSlots: student.currentRank.visibleStripeSlots,
  };
  const promocionesHistory: PromocionesHistoryRow[] = promotionHistory.map((promotion) => ({
    id: promotion.id,
    fromBeltLabel: locale === "es" ? promotion.fromBeltLabelEs : promotion.fromBeltLabelEn,
    fromStripes: promotion.fromStripes,
    toBeltLabel: locale === "es" ? promotion.toBeltLabelEs : promotion.toBeltLabelEn,
    toStripes: promotion.toStripes,
    awardedAtFormatted: formatTimestampInAcademyZone(promotion.awardedAt, locale) ?? "—",
    awardedByName: promotion.awardedByName,
    source: promotion.source,
    notes: promotion.notes,
  }));
  const creditHistory: PromotionCreditHistoryRow[] = creditHistoryRaw.map((credit) => ({
    id: credit.id,
    classesGranted: credit.classesGranted,
    reason: credit.reason,
    grantedAtFormatted: formatTimestampInAcademyZone(credit.grantedAt, locale) ?? "—",
    grantedByName: credit.grantedByName,
    active: credit.active,
  }));

  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {student.firstName} {student.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">{student.homeAcademy.name}</p>
        </div>
        <Badge variant="outline">{tStatus(student.status)}</Badge>
      </div>

      {/* MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d — "Awarding from the
          student detail page." Replaces the old read-only belt graphic +
          at-belt-summary card + standalone promotion-history card with one
          component: read-only display for every role, plus (ADMIN/DIRECTOR
          only) the award button and manual-correction form, both thin
          wrappers around the SAME `awardPromotion`/`correctPromotion` the
          dashboard queue and Phase 4's future flows will share. */}
      <PromocionesCard
        organizationId={context.organizationId}
        studentId={student.id}
        belt={currentBeltVisual}
        label={currentBeltLabel}
        currentStripes={student.currentStripes}
        maxStripes={summary.maxStripes}
        atBeltCount={summary.atBeltCount}
        creditedClasses={summary.creditedClasses}
        lifetimeCount={summary.lifetimeCount}
        nextTarget={cardNextTarget}
        remainingAttendance={summary.remainingAttendance}
        attendancesPerStripe={summary.attendancesPerStripe}
        dueDateFormatted={dueDateFormatted}
        isEligible={summary.isEligible}
        mode={summary.mode}
        history={promocionesHistory}
        creditHistory={creditHistory}
        canAct={canEdit}
        rankOptions={rankOptions}
        trackChange={
          canEdit
            ? {
                rankOptions: trackChangeRankOptions,
                defaultRankId: defaultTrackChangeRankId,
                isTransition: isTrackTransitionAge,
              }
            : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{tDetail("profile.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.phone")}</dt>
              <dd>{student.phone}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.email")}</dt>
              <dd>{student.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.currentBelt")}</dt>
              <dd>{currentBeltLabel}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.currentStripes")}</dt>
              <dd>{student.currentStripes}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{tDetail("profile.joinedAt")}</dt>
              <dd>{formatTimestampInAcademyZone(student.joinedAt, locale) ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.dateOfBirth")}</dt>
              <dd>{formatDateOnly(student.dateOfBirth) ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.guardianName")}</dt>
              <dd>{student.guardianName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.guardianPhone")}</dt>
              <dd>{student.guardianPhone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("create.emergencyContact")}</dt>
              <dd>{student.emergencyContact ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-sm text-muted-foreground">{tDetail("profile.notes")}</dt>
              <dd className="whitespace-pre-wrap">{student.notes ?? "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Real data as of Task 5 — the attendance-history card immediately
          below is still a genuine `comingLater` placeholder — this
          staff-facing attendance ledger view was never in scope (the
          student's own portal already has one via `getAttendanceHistory`). */}
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("attendanceHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{tDetail("comingLater")}</p>
        </CardContent>
      </Card>
      {/* Real data as of Task 2 — every PaymentPeriod row for this student,
          newest first, same "replace comingLater with a real list + empty
          state" shape as promotionHistory above. */}
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("paymentHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          {paymentHistory.length === 0 ? (
            <p className="text-muted-foreground">{tDetail("paymentHistory.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{tDetail("paymentHistory.columnPeriod")}</th>
                    <th className="pb-2 pr-4 font-medium">{tDetail("paymentHistory.columnPlan")}</th>
                    <th className="pb-2 pr-4 font-medium">{tDetail("paymentHistory.columnStatus")}</th>
                    <th className="pb-2 pr-4 font-medium">{tDetail("paymentHistory.columnAmount")}</th>
                    <th className="pb-2 font-medium">{tDetail("paymentHistory.columnNotes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentHistory.map((period) => (
                    <tr key={period.id} className="border-t">
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {formatPeriodMonth(period.year, period.month)}
                      </td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{period.planName}</td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant="outline">{tPaymentStatus(period.status)}</Badge>
                      </td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {period.amount != null ? formatMoney(period.amount, period.currency, locale) : "—"}
                      </td>
                      <td className="py-2 align-top whitespace-pre-wrap">{period.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <RegenerateCodeButton organizationId={context.organizationId} studentId={student.id} />

      {/* Any staff role can add an adjustment (spec §3 grants attendance
          marking/correction to INSTRUCTOR too) — deliberately NOT inside the
          canEdit gate below, which is ADMIN/DIRECTOR only. The server-side
          addAttendanceAdjustment is the real enforcement either way. */}
      <AddAdjustmentForm organizationId={context.organizationId} studentId={student.id} />

      {canEdit && (
        <div className="flex flex-col gap-4">
          {/* Only a PENDING student can be approved — the server action
              re-asserts that precondition itself; this just avoids offering
              a button that would always fail. */}
          {student.status === "PENDING" && (
            <ApproveStudentButton organizationId={context.organizationId} studentId={student.id} />
          )}
          <EditStudentForm
            organizationId={context.organizationId}
            student={{ ...student, currentBeltLabel }}
          />
          {/* ADMIN/DIRECTOR only, same as edit/archive above — the real
              enforcement is server-side in recordPayment itself
              (requireTenantContext(["ADMIN", "DIRECTOR"]) + a fresh
              isAcademyInTenantScope + plan-academy cross-check). Same shared
              `RecordPaymentForm` the new `/payments` route uses
              (REDESIGN_BRIEF.md §6.1) — locked to this one student here,
              wrapped in the same <details> toggle this page has always used. */}
          <details className="rounded border p-4">
            <summary className="cursor-pointer font-medium">{tDetail("recordPayment.toggle")}</summary>
            <div className="mt-4">
              <RecordPaymentForm
                organizationId={context.organizationId}
                students={[
                  {
                    id: student.id,
                    firstName: student.firstName,
                    lastName: student.lastName,
                    academyId: student.homeAcademyId,
                    academyName: student.homeAcademy.name,
                  },
                ]}
                plans={paymentPlans}
                currency={organizationCurrency}
                lockedStudentId={student.id}
                canManagePromotions={canEdit}
                defaults={{ month: `${currentYear}-${String(currentMonth).padStart(2, "0")}` }}
              />
            </div>
          </details>
          {/* An archived student can be restored — that is what the archive
              dialog's "you can restore them later" refers to. Archive is only
              offered while there is something to archive. */}
          {student.status === "ARCHIVED" ? (
            <RestoreStudentButton organizationId={context.organizationId} studentId={student.id} />
          ) : (
            <ArchiveStudentButton organizationId={context.organizationId} studentId={student.id} />
          )}
        </div>
      )}
    </main>
  );
}
