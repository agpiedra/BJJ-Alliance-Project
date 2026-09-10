import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { currentCrDateParts } from "@/lib/payments/get-current-period";
import { getStudentForStaff } from "./get-student";
import { getPromotionHistory } from "./get-promotion-history";
import { getPaymentHistory } from "./get-payment-history";
import { EditStudentForm } from "./edit-student-form";
import { ArchiveStudentButton } from "./archive-student-button";
import { ApproveStudentButton } from "./approve-student-button";
import { RegenerateCodeButton } from "./regenerate-code-button";
import { AddAdjustmentForm } from "./add-adjustment-form";
import { RecordPaymentForm } from "./record-payment-form";

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
  const session = await requireStaffSession();
  const { locale, id } = await params;

  // getStudentForStaff returns null both when the id doesn't exist at all
  // and when it exists but is outside this session's academy scope — the
  // page can't tell the two apart, and shouldn't: both render as a plain
  // 404, never a distinguishable "forbidden" that would confirm a guessed
  // id belongs to someone.
  const student = await getStudentForStaff(session, id);
  if (!student) {
    notFound();
  }

  const summary = await getAtBeltSummary(student.id);
  const promotionHistory = await getPromotionHistory(student.id);
  const paymentHistory = await getPaymentHistory(student.id);

  const t = await getTranslations("students");
  const tDetail = await getTranslations("students.detail");
  const tStatus = await getTranslations("students.status");
  const tBelt = await getTranslations("belt");
  const tPaymentStatus = await getTranslations("students.paymentStatus");

  // Edit/archive are gated to ADMIN/DIRECTOR in the UI as defense in depth —
  // the real gate is server-side in updateStudent/archiveStudent
  // (requireStaffSession(["ADMIN", "DIRECTOR"]) + a fresh isAcademyInScope
  // check). Code regeneration has no role restriction (spec §4.1), so it's
  // shown to any staff session.
  const canEdit = session.role === "ADMIN" || session.role === "DIRECTOR";

  // `recordPayment` re-checks ADMIN/DIRECTOR + plan-academy scope itself —
  // this fetch just avoids the extra query/render when the form won't be
  // shown at all (same `canEdit` gate as edit/archive above).
  const paymentPlans = canEdit
    ? await prisma.paymentPlan.findMany({
        where: { academyId: student.homeAcademyId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      })
    : [];
  const { year: currentYear, month: currentMonth } = currentCrDateParts();

  function formatPeriodMonth(year: number, month: number): string {
    return new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
      year: "numeric",
      month: "long",
    }).format(new Date(Date.UTC(year, month - 1, 1)));
  }

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

      {/* Read-only. Belt and stripes are NOT editable from this page:
          changing them is Phase 4's promotion flow, which must also write a
          `Promotion` row and reset `beltAwardedAt`. A plain field edit would
          desync rank from promotion history and from the
          attendance-since-promotion counter Phase 3 derives. */}
      <BeltGraphic belt={student.currentBelt} stripes={student.currentStripes} />

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
              <dd>{tBelt(student.currentBelt)}</dd>
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

      {/* Task 2's getAtBeltSummary, surfaced here now that it exists — the
          same figures the kiosk shows a student at check-in time, but for
          staff reviewing this profile. */}
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("atBeltSummary.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">{tDetail("atBeltSummary.atBeltCount")}</dt>
              <dd>{summary.atBeltCount}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{tDetail("atBeltSummary.lifetimeCount")}</dt>
              <dd>{summary.lifetimeCount}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                {tDetail("atBeltSummary.remainingToNextStripe")}
              </dt>
              <dd>{summary.remainingToNextStripe ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{tDetail("atBeltSummary.examEligible")}</dt>
              <dd>{summary.examEligible ? tDetail("atBeltSummary.yes") : tDetail("atBeltSummary.no")}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Real data as of Task 5 — every Promotion row for this student,
          newest first. The payment-history card below is now real data too
          (Phase 6 Task 2); only the attendance-history card immediately
          after it is still a genuine `comingLater` placeholder — this
          staff-facing attendance ledger view was never in either task's
          scope (the student's own portal already has one via
          `getAttendanceHistory`). */}
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("promotionHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          {promotionHistory.length === 0 ? (
            <p className="text-muted-foreground">{tDetail("promotionHistory.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">
                      {tDetail("promotionHistory.columnDate")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {tDetail("promotionHistory.columnChange")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {tDetail("promotionHistory.columnBy")}
                    </th>
                    <th className="pb-2 font-medium">
                      {tDetail("promotionHistory.columnNotes")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {promotionHistory.map((promotion) => (
                    <tr key={promotion.id} className="border-t">
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {formatTimestampInAcademyZone(promotion.awardedAt, locale)}
                      </td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">
                        {tBelt(promotion.fromBelt)} {promotion.fromStripes} →{" "}
                        {tBelt(promotion.toBelt)} {promotion.toStripes}
                      </td>
                      <td className="py-2 pr-4 align-top">{promotion.awardedByName}</td>
                      <td className="py-2 align-top whitespace-pre-wrap">
                        {promotion.notes ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
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
                        {period.amount ?? "—"}
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

      <RegenerateCodeButton studentId={student.id} />

      {/* Any staff role can add an adjustment (spec §3 grants attendance
          marking/correction to INSTRUCTOR too) — deliberately NOT inside the
          canEdit gate below, which is ADMIN/DIRECTOR only. The server-side
          addAttendanceAdjustment is the real enforcement either way. */}
      <AddAdjustmentForm studentId={student.id} />

      {canEdit && (
        <div className="flex flex-col gap-4">
          {/* Only a PENDING student can be approved — the server action
              re-asserts that precondition itself; this just avoids offering
              a button that would always fail. */}
          {student.status === "PENDING" && <ApproveStudentButton studentId={student.id} />}
          <EditStudentForm student={student} />
          {/* ADMIN/DIRECTOR only, same as edit/archive above — the real
              enforcement is server-side in recordPayment itself
              (requireStaffSession(["ADMIN", "DIRECTOR"]) + a fresh
              isAcademyInScope + plan-academy cross-check). */}
          <RecordPaymentForm
            studentId={student.id}
            plans={paymentPlans}
            defaultYear={currentYear}
            defaultMonth={currentMonth}
          />
          <ArchiveStudentButton
            studentId={student.id}
            disabled={student.status === "ARCHIVED"}
          />
        </div>
      )}
    </main>
  );
}
