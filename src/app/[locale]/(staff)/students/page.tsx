import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { FilterBar, FilterBarSearch, FilterBarSelect } from "@/components/ui/filter-bar";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { Pill } from "@/components/ui/pill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";
import { listStudents } from "./actions";
import { CreateStudentForm } from "./create-student-form";
import { StudentStatus } from "@/generated/prisma/client";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import type { NextTarget } from "@/lib/promotion/engine";
import { promotionDistance, compareByPromotion } from "@/lib/students/promotion-distance";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { ContactPaymentStatus } from "@/lib/students/contact-list";
import { ZONE } from "@/lib/scheduling/zone";

// Staff data an admin/director could change without a redeploy (students,
// academy roster) — never frozen at build time, same reasoning as /signup.
export const dynamic = "force-dynamic";

// MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2: the old `Belt` enum is gone
// (replaced by BeltRank, which is data now) — this roster filter only needs
// the 5 known adult codes, so a plain local literal list stays, same as
// every other belt-select in this codebase.
const BELT_OPTIONS = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"] as const;
const STATUS_OPTIONS = Object.values(StudentStatus);
const PAYMENT_STATUS_OPTIONS: ContactPaymentStatus[] = ["PAID", "PENDING", "OVERDUE", "PROMO", "EXEMPT", "NOT_RECORDED"];

// Sentinel distinct from "no `status` param at all" (which now defaults to
// ACTIVE below) — REDESIGN_BRIEF.md §4.2: "Default status filter must be
// Activos... while still letting a user explicitly select Todos to clear it."
const STATUS_ALL = "ALL";

// §4.2's "Última asistencia... hace 20 días" stale-marker threshold. The
// brief doesn't pin an exact number ("you decide a sensible staleness
// threshold if the brief doesn't give one exactly, e.g. 14+ days") — 14 is
// chosen to sit safely below dashboard's own 7-day "contact" list floor
// doubled, so a row only gets flagged here once it's meaningfully stale, not
// merely inside the contact-list's own outreach window.
const STALE_ATTENDANCE_DAYS = 14;

function parseBelt(value: string | undefined): string | undefined {
  return value && (BELT_OPTIONS as readonly string[]).includes(value) ? value : undefined;
}

function parseStatus(value: string | undefined): StudentStatus | undefined {
  if (value === undefined) return StudentStatus.ACTIVE;
  if (value === STATUS_ALL) return undefined;
  return (STATUS_OPTIONS as string[]).includes(value) ? (value as StudentStatus) : StudentStatus.ACTIVE;
}

function parsePaymentStatus(value: string | undefined): ContactPaymentStatus | undefined {
  return value && (PAYMENT_STATUS_OPTIONS as string[]).includes(value) ? (value as ContactPaymentStatus) : undefined;
}

function paymentPillVariant(status: ContactPaymentStatus): "ok" | "warn" | "bad" | "accent" | "plain" {
  switch (status) {
    case "OVERDUE":
      return "bad";
    case "PENDING":
      return "warn";
    case "PROMO":
      return "accent";
    case "PAID":
    case "EXEMPT":
      return "ok";
    default:
      return "plain";
  }
}

function paymentStatusLabel(
  status: ContactPaymentStatus,
  t: (key: string) => string,
  tPaymentStatus: (key: string) => string,
): string {
  if (status === "OVERDUE") return t("paymentStatus.overdue");
  if (status === "NOT_RECORDED") return t("paymentStatus.notRecorded");
  return tPaymentStatus(status);
}

/**
 * Progreso column's current/target pair. Purely a display-side read of
 * `getAtBeltSummary`'s already-computed fields (Rule 8: never reimplement
 * belt math) — mirrors the exam-row target formula dashboard/page.tsx's
 * "Cola de promociones" panel already uses
 * (`maxStripes * attendancesPerStripe + attendancesForExam`). `null` means
 * no further computable progress at all (e.g. a maxed-out belt with no exam
 * threshold configured), which the Progreso cell renders as "—".
 */
function resolveProgressTarget(summary: {
  atBeltCount: number;
  currentStripes: number;
  nextTarget: NextTarget;
  maxStripes: number;
  attendancesPerStripe: number;
  attendancesForExam: number;
}): { current: number; target: number } | null {
  if (summary.nextTarget === "STRIPE") {
    return { current: summary.atBeltCount, target: (summary.currentStripes + 1) * summary.attendancesPerStripe };
  }
  if (summary.nextTarget === "BELT" && summary.attendancesForExam > 0) {
    return {
      current: summary.atBeltCount,
      target: summary.maxStripes * summary.attendancesPerStripe + summary.attendancesForExam,
    };
  }
  return null;
}

type StudentsSearchParams = {
  search?: string;
  belt?: string;
  status?: string;
  payment?: string;
  academyId?: string;
};

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<StudentsSearchParams>;
}) {
  const context = await requireTenantContext();
  const params = await searchParams;

  const students = await listStudents(context, {
    search: params.search,
    belt: parseBelt(params.belt),
    status: parseStatus(params.status),
    academyId: params.academyId,
  });

  // Per-row lookups, batched via Promise.all across the fetched student
  // list — same accepted per-row-query shape as Phase 4's
  // classifyActiveStudents at this app's current scale (a single gym's
  // roster).
  const today = currentCrDateParts();
  const now = DateTime.now().setZone(ZONE);
  // Resolved ONCE for the whole roster, not once per row — see
  // resolvePromotionConfigMap's own doc comment on the N+1 this avoids.
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const rosterExtras = await Promise.all(
    students.map(async (student) => {
      const [summary, lastAttendance, currentPeriod] = await Promise.all([
        getAtBeltSummary(student.id, configByTrack),
        prisma.attendanceRecord.findFirst({
          where: { studentId: student.id },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        }),
        getCurrentPaymentPeriod(student.id, today),
      ]);

      // Mechanical migration off eligibility.ts's classifyEligibility (Phase
      // 2c-ii) — same two branches this roster badge ever checked, now read
      // straight from the engine's own vocabulary.
      const eligibility: "stripe-eligible" | "exam-eligible" | "none" =
        summary.nextTarget === "STRIPE" && summary.isEligible
          ? "stripe-eligible"
          : summary.nextTarget === "BELT" && summary.isEligible
            ? "exam-eligible"
            : "none";

      const overdue = isOverdue(currentPeriod, today);
      // Same precedence the roster's payment pill already used before this
      // restyle (overdue takes priority over a recorded PENDING period) —
      // §4.2's new payment filter has to agree with what the pill shows, or
      // filtering by "Atrasado" could hide/show different rows than the
      // pills visually suggest.
      const paymentStatus: ContactPaymentStatus = overdue
        ? "OVERDUE"
        : currentPeriod
          ? currentPeriod.status
          : "NOT_RECORDED";

      const lastAttendanceAt = lastAttendance?.occurredAt ?? null;
      const daysSinceLastAttendance = lastAttendanceAt
        ? Math.floor(now.diff(DateTime.fromJSDate(lastAttendanceAt, { zone: ZONE }), "days").days)
        : null;

      return {
        studentId: student.id,
        summary,
        eligibility,
        lastAttendanceAt,
        daysSinceLastAttendance,
        currentPeriod,
        paymentStatus,
        distance: promotionDistance({
          examEligible: summary.nextTarget === "BELT" && summary.isEligible,
          remainingToNextStripe: summary.remainingAttendance,
        }),
      };
    }),
  );
  const rosterExtrasByStudentId = new Map(rosterExtras.map((extra) => [extra.studentId, extra]));

  // §4.2's new payment-status filter: `listStudents`/Prisma can't express
  // this (payment status is computed above, not a column), so — per the
  // task's own guidance for this app's scale — it's a plain post-filter over
  // the roster already fetched, not a schema/query change.
  const paymentFilter = parsePaymentStatus(params.payment);
  const filteredStudents = paymentFilter
    ? students.filter((student) => rosterExtrasByStudentId.get(student.id)?.paymentStatus === paymentFilter)
    : students;

  // §4.2 "Sort by closest to promotion by default": ascending remaining
  // count (0 = already eligible), computed AFTER the fetch since it depends
  // on the per-row belt-progress lookups above. Tie-breaker is the roster's
  // previous default order (lastName, then firstName) so equal-distance rows
  // don't reshuffle unpredictably between reloads.
  const sortedStudents = [...filteredStudents].sort((a, b) =>
    compareByPromotion(
      { distance: rosterExtrasByStudentId.get(a.id)!.distance, lastName: a.lastName, firstName: a.firstName },
      { distance: rosterExtrasByStudentId.get(b.id)!.distance, lastName: b.lastName, firstName: b.firstName },
    ),
  );

  // The academies available for the filter switcher and the create-student
  // form's academy select are the same set: every academy for ADMIN
  // (unrestricted scope), or only the academies this DIRECTOR/INSTRUCTOR is
  // actually assigned to (spec §1b — non-admins get no switcher for
  // academies outside their scope).
  const scopedAcademyIds = Array.isArray(context.academyIds) ? context.academyIds : [];
  const academies =
    context.organizationRole === "ADMIN"
      ? await getScopedDb(context).academy.findMany({
          where: {},
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : await getScopedDb(context).academy.findMany({
          where: { id: { in: scopedAcademyIds } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        });

  // Page-header sub line numbers (Rule 5: "numbers get context") — scoped
  // the same way listStudents itself scopes a non-ADMIN session, so a
  // DIRECTOR/INSTRUCTOR only ever sees counts for their own academy/academies.
  const scopedAcademyWhere =
    context.organizationRole === "ADMIN" ? {} : { homeAcademyId: { in: scopedAcademyIds } };
  const [activeCount, inactiveCount] = await Promise.all([
    getScopedDb(context).student.count({ where: { ...scopedAcademyWhere, status: "ACTIVE" } }),
    getScopedDb(context).student.count({ where: { ...scopedAcademyWhere, status: "INACTIVE" } }),
  ]);

  const t = await getTranslations("students");
  const tBelt = await getTranslations("belt");
  const tStatus = await getTranslations("students.status");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const locale = await getLocale();

  const canCreate = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("eyebrow")}</p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("sub", { active: activeCount, inactive: inactiveCount })}
        </p>
      </header>

      {/* Server-side gate is the real enforcement (createStudent itself
          re-checks the role) — this only avoids showing the control to a
          role that would just be rejected, as defense in depth. */}
      {canCreate && <CreateStudentForm organizationId={context.organizationId} academies={academies} />}

      <Card>
        <form method="get">
          <FilterBar>
            <label htmlFor="students-search" className="sr-only">
              {t("filters.search")}
            </label>
            <FilterBarSearch
              id="students-search"
              type="search"
              name="search"
              defaultValue={params.search ?? ""}
              placeholder={t("filters.searchPlaceholder")}
            />

            <label htmlFor="students-belt" className="sr-only">
              {t("filters.belt")}
            </label>
            <FilterBarSelect id="students-belt" name="belt" defaultValue={params.belt ?? ""}>
              <option value="">{t("filters.allBelts")}</option>
              {BELT_OPTIONS.map((belt) => (
                <option key={belt} value={belt}>
                  {tBelt(belt)}
                </option>
              ))}
            </FilterBarSelect>

            <label htmlFor="students-status" className="sr-only">
              {t("filters.status")}
            </label>
            <FilterBarSelect
              id="students-status"
              name="status"
              defaultValue={parseStatus(params.status) ?? STATUS_ALL}
            >
              <option value={STATUS_ALL}>{t("filters.allStatuses")}</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {tStatus(status)}
                </option>
              ))}
            </FilterBarSelect>

            <label htmlFor="students-payment" className="sr-only">
              {t("filters.payment")}
            </label>
            <FilterBarSelect id="students-payment" name="payment" defaultValue={params.payment ?? ""}>
              <option value="">{t("filters.allPayments")}</option>
              {PAYMENT_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {paymentStatusLabel(status, t, tPaymentStatus)}
                </option>
              ))}
            </FilterBarSelect>

            {context.organizationRole === "ADMIN" && (
              <>
                <label htmlFor="students-academy" className="sr-only">
                  {t("filters.academy")}
                </label>
                <FilterBarSelect id="students-academy" name="academyId" defaultValue={params.academyId ?? ""}>
                  <option value="">{t("filters.bothAcademies")}</option>
                  {academies.map((academy) => (
                    <option key={academy.id} value={academy.id}>
                      {academy.name}
                    </option>
                  ))}
                </FilterBarSelect>
              </>
            )}

            <Button type="submit" variant="outline" size="sm">
              {t("filters.submit")}
            </Button>
          </FilterBar>
        </form>

        <CardContent className="pt-4">
          {sortedStudents.length === 0 ? (
            <EmptyState message={t("empty")} />
          ) : (
            <DataTable>
              <DataTableHead>
                <DataTableHeaderRow>
                  <DataTableHeaderCell>{t("columns.name")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("columns.belt")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("columns.progress")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("columns.academy")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("columns.lastAttendance")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("columns.payment")}</DataTableHeaderCell>
                  <DataTableHeaderCell>
                    <span className="sr-only">{t("columns.flags")}</span>
                  </DataTableHeaderCell>
                </DataTableHeaderRow>
              </DataTableHead>
              <DataTableBody>
                {sortedStudents.map((student) => {
                  const extra = rosterExtrasByStudentId.get(student.id)!;
                  const progress = resolveProgressTarget(extra.summary);
                  const daysSinceLastAttendance = extra.daysSinceLastAttendance;
                  const stale = daysSinceLastAttendance !== null && daysSinceLastAttendance >= STALE_ATTENDANCE_DAYS;

                  return (
                    <DataTableRow key={student.id}>
                      <DataTableCell>
                        <a
                          href={`/${locale}/students/${student.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {student.firstName} {student.lastName}
                        </a>
                        {/* REDESIGN_BRIEF.md §4.2 deliberately drops the mock's
                            "· kiosco 4821" from this sub-line: the plaintext
                            kiosk code only ever exists at creation/regeneration
                            time (Student.codeHash is a one-way hash — see
                            create-student-action.ts / regenerate-code-button.tsx)
                            and is never retrievable afterward, by design. There
                            is no real value to show here after the fact, so
                            only the student's real email is shown. */}
                        <div className="text-[11px] text-muted-foreground">{student.email}</div>
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center gap-2">
                          <BeltBar
                            belt={{
                              primaryColor: student.currentRank.primaryColor,
                              centerStripeColor: student.currentRank.centerStripeColor,
                              barColor: student.currentRank.barColor,
                              stripeColors: student.currentRank.stripeColors,
                              maxStripes: student.currentRank.maxStripes,
                              visibleStripeSlots: student.currentRank.visibleStripeSlots,
                            }}
                            stripes={student.currentStripes}
                          />
                          <span className="whitespace-nowrap">
                            {locale === "es" ? student.currentRank.labelEs : student.currentRank.labelEn} ·{" "}
                            <span className="font-medium">
                              {t("beltStripes", { count: student.currentStripes })}
                            </span>
                          </span>
                        </div>
                      </DataTableCell>
                      <DataTableCell>
                        {progress ? (
                          <ProgressToNextGrade current={progress.current} target={progress.target} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </DataTableCell>
                      <DataTableCell>{student.homeAcademy.name}</DataTableCell>
                      <DataTableCell>
                        {extra.lastAttendanceAt ? (
                          <span>
                            {formatTimestampInAcademyZone(extra.lastAttendanceAt, locale)}
                            {stale && daysSinceLastAttendance !== null && (
                              <span className="ml-1 text-muted-foreground">
                                {t("staleAttendance", { days: daysSinceLastAttendance })}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Pill variant={paymentPillVariant(extra.paymentStatus)}>
                          {paymentStatusLabel(extra.paymentStatus, t, tPaymentStatus)}
                        </Pill>
                      </DataTableCell>
                      <DataTableCell>
                        {extra.eligibility === "exam-eligible" && (
                          <Pill variant="accent">{t("eligibility.exam")}</Pill>
                        )}
                        {extra.eligibility === "stripe-eligible" && (
                          <Pill variant="accent">{t("eligibility.stripe")}</Pill>
                        )}
                      </DataTableCell>
                    </DataTableRow>
                  );
                })}
              </DataTableBody>
            </DataTable>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
