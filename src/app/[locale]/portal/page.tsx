import { getTranslations } from "next-intl/server";
import { requireStudentSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { getAttendanceHistory } from "@/lib/students/attendance-history";
import { getOwnPromotionHistory } from "./get-promotion-history";
import { formatTimestampInAcademyZone } from "@/lib/format-date";

// A student's own belt/status could change without a redeploy (staff can
// promote them, adjust attendance, or flip their status any time) — never
// statically cached, same reasoning as the staff student-detail page and the
// kiosk page.
export const dynamic = "force-dynamic";

export default async function StudentPortalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const session = await requireStudentSession();
  const { locale } = await params;

  // Safe with no additional scope check: `session.studentId` came from the
  // session guard itself (re-verified against the DB on every call), never
  // from a route param an attacker could substitute another student's id
  // into — unlike `students/[id]/page.tsx`, which must scope-check a
  // caller-supplied id before trusting it.
  const [student, summary, attendanceHistory, promotionHistory] = await Promise.all([
    prisma.student.findUniqueOrThrow({
      where: { id: session.studentId },
      select: { firstName: true, currentBelt: true, currentStripes: true, status: true },
    }),
    getAtBeltSummary(session.studentId),
    getAttendanceHistory(session.studentId),
    getOwnPromotionHistory(session.studentId),
  ]);

  const t = await getTranslations("portal");
  const tBelt = await getTranslations("belt");
  const tStatusNotice = await getTranslations("portal.statusNotice");
  const tAttendanceType = await getTranslations("portal.attendanceHistory.type");

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-4">
      <div>
        <h1 className="text-2xl font-bold">{t("greeting", { name: student.firstName })}</h1>
      </div>

      {/* Login itself is not gated on Student.status (see
          requireStudentSession's doc comment) — a PENDING or ARCHIVED
          student still sees their full portal, just with an honest notice
          up top rather than any of the sections below being hidden. */}
      {student.status !== "ACTIVE" && (
        <div
          role="status"
          className="rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground"
        >
          {tStatusNotice(student.status)}
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        <BeltGraphic belt={student.currentBelt} stripes={student.currentStripes} maxStripes={summary.maxStripes} />
      </div>

      {/*
        TASK 3 SLOT: the self check-in button/section belongs here — right
        after the belt graphic and before the progress card, so it's the
        first actionable thing a student sees on this mobile page (the
        primary reason they'd open /portal at the gym). Nothing is rendered
        here yet; Task 3 owns building it.
      */}

      <Card>
        <CardHeader>
          <CardTitle>{t("progress.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p>{t("progress.atBeltCount", { count: summary.atBeltCount })}</p>

          {summary.nextStripeAt !== null && (
            <p className="text-muted-foreground">
              {t("progress.towardNextStripe", {
                current: summary.atBeltCount,
                target: summary.nextStripeAt,
              })}
            </p>
          )}

          {summary.remainingToNextStripe !== null && (
            <p className="text-muted-foreground">
              {t("progress.remainingToNextStripe", { count: summary.remainingToNextStripe })}
            </p>
          )}

          {summary.remainingToNextStripe === null && summary.examEligible && (
            <p className="font-medium">{t("progress.examEligible")}</p>
          )}

          <p className="text-muted-foreground">
            {t("progress.lifetimeCount", { count: summary.lifetimeCount })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("attendanceHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          {attendanceHistory.length === 0 ? (
            <p className="text-muted-foreground">{t("attendanceHistory.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {attendanceHistory.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {formatTimestampInAcademyZone(entry.date, locale)}
                    </span>
                    <span className={entry.delta < 0 ? "text-destructive" : "text-foreground"}>
                      {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    {entry.className ?? tAttendanceType(entry.type)}
                  </span>
                  {entry.reason && (
                    <span className="text-muted-foreground italic">{entry.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("promotionHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          {promotionHistory.length === 0 ? (
            <p className="text-muted-foreground">{t("promotionHistory.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {promotionHistory.map((promotion) => (
                <li key={promotion.id} className="flex flex-col gap-0.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {formatTimestampInAcademyZone(promotion.awardedAt, locale)}
                    </span>
                    <Badge variant="outline">
                      {tBelt(promotion.fromBelt)} {promotion.fromStripes} → {tBelt(promotion.toBelt)}{" "}
                      {promotion.toStripes}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">
                    {t("promotionHistory.awardedBy", { name: promotion.awardedByName })}
                  </span>
                  {promotion.notes && (
                    <span className="text-muted-foreground italic">{promotion.notes}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("paymentStatus.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{t("paymentStatus.comingLater")}</p>
        </CardContent>
      </Card>
    </main>
  );
}
