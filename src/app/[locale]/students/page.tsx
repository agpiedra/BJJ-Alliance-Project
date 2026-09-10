import { getLocale, getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listStudents } from "./actions";
import { CreateStudentForm } from "./create-student-form";
import { Belt, StudentStatus } from "@/generated/prisma/client";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";

// Staff data an admin/director could change without a redeploy (students,
// academy roster) — never frozen at build time, same reasoning as /signup.
export const dynamic = "force-dynamic";

const BELT_OPTIONS = Object.values(Belt);
const STATUS_OPTIONS = Object.values(StudentStatus);

function parseBelt(value: string | undefined): Belt | undefined {
  return value && (BELT_OPTIONS as string[]).includes(value) ? (value as Belt) : undefined;
}

function parseStatus(value: string | undefined): StudentStatus | undefined {
  return value && (STATUS_OPTIONS as string[]).includes(value) ? (value as StudentStatus) : undefined;
}

type StudentsSearchParams = {
  search?: string;
  belt?: string;
  status?: string;
  academyId?: string;
};

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<StudentsSearchParams>;
}) {
  const session = await requireStaffSession();
  const params = await searchParams;

  const students = await listStudents(session, {
    search: params.search,
    belt: parseBelt(params.belt),
    status: parseStatus(params.status),
    academyId: params.academyId,
  });

  // Per-row lookups, batched via Promise.all across the fetched student
  // list — same accepted per-row-query shape as Phase 4's
  // classifyActiveStudents at this app's current scale (a single gym's
  // roster). Two of these three were previously blocked ("not computable
  // yet"); both getAtBeltSummary (Phase 3) and the attendance ledger
  // (Phase 3) have existed for months, they just weren't wired up here —
  // only the third (payment tracking) is genuinely new as of this task.
  const today = currentCrDateParts();
  const rosterExtras = await Promise.all(
    students.map(async (student) => {
      const [summary, lastAttendance, currentPeriod] = await Promise.all([
        getAtBeltSummary(student.id),
        prisma.attendanceRecord.findFirst({
          where: { studentId: student.id },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        }),
        getCurrentPaymentPeriod(student.id),
      ]);

      return {
        studentId: student.id,
        atBeltCount: summary.atBeltCount,
        lastAttendanceAt: lastAttendance?.occurredAt ?? null,
        currentPeriod,
        overdue: isOverdue(currentPeriod, today),
      };
    }),
  );
  const rosterExtrasByStudentId = new Map(rosterExtras.map((extra) => [extra.studentId, extra]));

  // The academies available for the filter switcher and the create-student
  // form's academy select are the same set: every academy for ADMIN
  // (unrestricted scope), or only the academies this DIRECTOR/INSTRUCTOR is
  // actually assigned to (spec §1b — non-admins get no switcher for
  // academies outside their scope).
  const scopedAcademyIds = Array.isArray(session.academyIds) ? session.academyIds : [];
  const academies =
    session.role === "ADMIN"
      ? await prisma.academy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : await prisma.academy.findMany({
          where: { id: { in: scopedAcademyIds } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        });

  const t = await getTranslations("students");
  const tBelt = await getTranslations("belt");
  const tStatus = await getTranslations("students.status");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const locale = await getLocale();

  const canCreate = session.role === "ADMIN" || session.role === "DIRECTOR";

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("filters.search")}</span>
          <input
            type="text"
            name="search"
            defaultValue={params.search ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("filters.belt")}</span>
          <select name="belt" defaultValue={params.belt ?? ""} className="rounded border px-3 py-2">
            <option value="">{t("filters.allBelts")}</option>
            {BELT_OPTIONS.map((belt) => (
              <option key={belt} value={belt}>
                {tBelt(belt)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("filters.status")}</span>
          <select name="status" defaultValue={params.status ?? ""} className="rounded border px-3 py-2">
            <option value="">{t("filters.allStatuses")}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {tStatus(status)}
              </option>
            ))}
          </select>
        </label>
        {session.role === "ADMIN" && (
          <label className="flex flex-col gap-1">
            <span className="text-sm">{t("filters.academy")}</span>
            <select
              name="academyId"
              defaultValue={params.academyId ?? ""}
              className="rounded border px-3 py-2"
            >
              <option value="">{t("filters.bothAcademies")}</option>
              {academies.map((academy) => (
                <option key={academy.id} value={academy.id}>
                  {academy.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="outline">
          {t("filters.submit")}
        </Button>
      </form>

      {/* Server-side gate is the real enforcement (createStudent itself
          re-checks the role) — this only avoids showing the control to a
          role that would just be rejected, as defense in depth. */}
      {canCreate && <CreateStudentForm academies={academies} />}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-4">{t("columns.name")}</th>
              <th className="py-2 pr-4">{t("columns.belt")}</th>
              <th className="py-2 pr-4">{t("columns.academy")}</th>
              <th className="py-2 pr-4">{t("columns.status")}</th>
              <th className="py-2 pr-4">{t("columns.atBeltCount")}</th>
              <th className="py-2 pr-4">{t("columns.lastAttendance")}</th>
              <th className="py-2 pr-4">{t("columns.payment")}</th>
              <th className="py-2 pr-4">
                <span className="sr-only">{t("columns.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {students.map((student) => {
              const extra = rosterExtrasByStudentId.get(student.id);
              const paymentBadge = extra?.overdue
                ? { label: t("paymentStatus.overdue"), variant: "destructive" as const }
                : extra?.currentPeriod
                  ? { label: tPaymentStatus(extra.currentPeriod.status), variant: "outline" as const }
                  : { label: t("paymentStatus.notRecorded"), variant: "secondary" as const };

              return (
                <tr key={student.id} className="border-b">
                  <td className="py-2 pr-4">
                    {student.firstName} {student.lastName}
                  </td>
                  <td className="py-2 pr-4">
                    <BeltGraphic belt={student.currentBelt} stripes={student.currentStripes} />
                  </td>
                  <td className="py-2 pr-4">{student.homeAcademy.name}</td>
                  <td className="py-2 pr-4">
                    <Badge variant="outline">{tStatus(student.status)}</Badge>
                  </td>
                  <td className="py-2 pr-4">{extra?.atBeltCount ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {formatTimestampInAcademyZone(extra?.lastAttendanceAt ?? null, locale) ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge variant={paymentBadge.variant}>{paymentBadge.label}</Badge>
                  </td>
                  <td className="py-2 pr-4">
                    <a href={`/${locale}/students/${student.id}`} className="underline">
                      {t("columns.viewLink")}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {students.length === 0 && <p className="py-4 text-muted-foreground">{t("empty")}</p>}
      </div>
    </main>
  );
}
