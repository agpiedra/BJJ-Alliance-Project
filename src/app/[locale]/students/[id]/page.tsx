import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStudentForStaff } from "./get-student";
import { EditStudentForm } from "./edit-student-form";
import { ArchiveStudentButton } from "./archive-student-button";
import { ApproveStudentButton } from "./approve-student-button";
import { RegenerateCodeButton } from "./regenerate-code-button";

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

/**
 * A TIMESTAMP field (`joinedAt`) — must be rendered in the academy's wall
 * clock, never `toISOString().slice(0, 10)`. Costa Rica is UTC-6 with no
 * DST, so a student who joined at 19:00 CR has a UTC timestamp already on
 * the NEXT calendar day; the naive slice displays their join date as a day
 * late. Same bug class Phase 1's schema comment on
 * `AttendanceRecord.date` warns about.
 */
function formatTimestampInAcademyZone(date: Date | null, locale: string): string | null {
  if (!date) return null;
  return new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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

  const t = await getTranslations("students");
  const tDetail = await getTranslations("students.detail");
  const tStatus = await getTranslations("students.status");
  const tBelt = await getTranslations("belt");

  // Edit/archive are gated to ADMIN/DIRECTOR in the UI as defense in depth —
  // the real gate is server-side in updateStudent/archiveStudent
  // (requireStaffSession(["ADMIN", "DIRECTOR"]) + a fresh isAcademyInScope
  // check). Code regeneration has no role restriction (spec §4.1), so it's
  // shown to any staff session.
  const canEdit = session.role === "ADMIN" || session.role === "DIRECTOR";

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

      {/* Phases 3/4/6 own this data; these sections are placeholders until
          the attendance ledger, promotion workflow, and payment tracking
          ship. */}
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("promotionHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{tDetail("comingLater")}</p>
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
      <Card>
        <CardHeader>
          <CardTitle>{tDetail("paymentHistory.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{tDetail("comingLater")}</p>
        </CardContent>
      </Card>

      <RegenerateCodeButton studentId={student.id} />

      {canEdit && (
        <div className="flex flex-col gap-4">
          {/* Only a PENDING student can be approved — the server action
              re-asserts that precondition itself; this just avoids offering
              a button that would always fail. */}
          {student.status === "PENDING" && <ApproveStudentButton studentId={student.id} />}
          <EditStudentForm student={student} />
          <ArchiveStudentButton
            studentId={student.id}
            disabled={student.status === "ARCHIVED"}
          />
        </div>
      )}
    </main>
  );
}
