import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { hasAcademyChoice } from "@/lib/staff-shell/academy-choice";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
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
import { buildProgressView } from "@/lib/promotion/progress-view";
import { listStudents } from "./actions";
import { CreateStudentForm } from "./create-student-form";
import { isEnrollmentBillingActive } from "./create-student-core";
import { listSelectablePlans } from "@/lib/payments/list-plans";
import { StudentStatus, Track } from "@/generated/prisma/client";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { promotionDistance, compareByPromotion } from "@/lib/students/promotion-distance";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import { isOverdue } from "@/lib/payments/overdue";
import type { ContactPaymentStatus } from "@/lib/students/contact-list";
import { parseTrack } from "@/lib/students/parse-track";
import { ZONE } from "@/lib/scheduling/zone";
import { isLedgerActiveForOrg, listRosterPaymentFacts, toRosterLedgerDisplay, type RosterLedgerDisplay } from "@/lib/dues/roster-payment-facts-queries";
import { RosterLedgerStatus, RosterLedgerUnavailable } from "./roster-ledger-status";

// §2.2.1/§3 decision 5: decision 5 approved a NEW, independent ledger flag set — it did NOT approve a mapping FROM
// any legacy `?payment=` value (reusing `parsePaymentStatus`'s own validation below to detect one). Every legacy
// value has no honest ledger equivalent today, so a bookmark using one gets an EXPLICIT notice once `ledgerActive`
// is true, never a silent reinterpretation into one of the new flags the bookmarker never intended.
const LEDGER_FILTER_KEYS = ["debt", "noDebt", "monthlyPastGrace", "signupPastDue", "pendingConversion", "configIssue"] as const;
type LedgerFilterKey = (typeof LEDGER_FILTER_KEYS)[number];

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

type StudentsSearchParams = {
  search?: string;
  belt?: string;
  status?: string;
  payment?: string;
  academyId?: string;
  track?: string;
  debt?: string;
  noDebt?: string;
  monthlyPastGrace?: string;
  signupPastDue?: string;
  pendingConversion?: string;
  configIssue?: string;
};

/** The approved independent ledger flags actually checked in the request — non-exclusive, any subset. */
function parseLedgerFilters(params: StudentsSearchParams): Set<LedgerFilterKey> {
  const active = new Set<LedgerFilterKey>();
  for (const key of LEDGER_FILTER_KEYS) {
    if (params[key] === "1") active.add(key);
  }
  return active;
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<StudentsSearchParams>;
}) {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  const params = await searchParams;

  const students = await listStudents(context, {
    search: params.search,
    belt: parseBelt(params.belt),
    status: parseStatus(params.status),
    academyId: params.academyId,
    track: parseTrack(params.track),
  });

  // ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.4: ONE captured instant, read ONCE per page load, BEFORE any
  // per-student work. `ledgerActive: false` (the real production default) keeps every line below byte-identical to
  // this page's pre-integration code — `getCurrentPaymentPeriod`/`isOverdue` still run per student, unchanged.
  const ledgerActive = await isLedgerActiveForOrg(context.organizationId);

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
      // §2.2: when the ledger is active, the legacy per-student `getCurrentPaymentPeriod` call is skipped entirely
      // (not just unused) — that is the exact per-student query this integration replaces with the batched call
      // below. Attendance/belt-summary queries are unrelated and always run, either way.
      const [summary, lastAttendance, currentPeriod] = await Promise.all([
        getAtBeltSummary(student.id, context.organizationId, configByTrack),
        prisma.attendanceRecord.findFirst({
          where: { studentId: student.id, organizationId: context.organizationId, voidedAt: null },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        }),
        ledgerActive ? Promise.resolve(null) : getCurrentPaymentPeriod(student.id, context.organizationId, today),
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

  // §2.2: batched (ceil(N/60) calls, bounded concurrency, one shared `now`) — replaces the per-student
  // `getCurrentPaymentPeriod` loop above ONLY when the ledger is active for this organization. A chunk failure or a
  // missing per-student entry renders as a distinct "unavailable" flag, never "paid"/"no debt".
  type LedgerDisplayEntry = { kind: "ledger"; display: RosterLedgerDisplay } | { kind: "unavailable" };
  const ledgerDisplayByStudentId = new Map<string, LedgerDisplayEntry>();
  if (ledgerActive) {
    const { byStudentId } = await listRosterPaymentFacts(context, students.map((s) => s.id), now.toJSDate());
    for (const student of students) {
      const fact = byStudentId.get(student.id);
      ledgerDisplayByStudentId.set(
        student.id,
        fact?.ok ? { kind: "ledger", display: toRosterLedgerDisplay(fact.facts, fact.todayIso) } : { kind: "unavailable" },
      );
    }
  }

  // §2.2.1/§3 decision 5: when the ledger is active, the legacy `?payment=` enum has no honest mapping at all
  // (decision 5 approved a NEW flag set, not a mapping FROM the old one) — a bookmark using it gets an explicit
  // notice, never silent reinterpretation or silent ignoring. When inactive, the legacy filter still works exactly
  // as it always has (byte-identical requirement, §7).
  const legacyPaymentParam = parsePaymentStatus(params.payment);
  const showLegacyBookmarkNotice = ledgerActive && legacyPaymentParam !== undefined;
  const activeLedgerFilters = ledgerActive ? parseLedgerFilters(params) : new Set<LedgerFilterKey>();

  // §4.2's new payment-status filter: `listStudents`/Prisma can't express
  // this (payment status is computed above, not a column), so — per the
  // task's own guidance for this app's scale — it's a plain post-filter over
  // the roster already fetched, not a schema/query change.
  const filteredStudents = ledgerActive
    ? students.filter((student) => {
        const entry = ledgerDisplayByStudentId.get(student.id);
        // An unavailable row is never silently counted as matching OR not-matching any filter — its own
        // unavailability is itself the visible state, always shown regardless of which filters are active.
        if (!entry || entry.kind === "unavailable") return true;
        if (activeLedgerFilters.size === 0) return true;
        return [...activeLedgerFilters].some((key) => entry.display.flags[key]);
      })
    : legacyPaymentParam
      ? students.filter((student) => rosterExtrasByStudentId.get(student.id)?.paymentStatus === legacyPaymentParam)
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

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: the create-student form's
  // track selector filters this SAME list client-side rather than making a
  // round trip per track change — both tracks' ranks are cheap (18 rows
  // total) and org-scoped once here.
  const createStudentRankOptions = await getScopedDb(context).beltRank.findMany({
    orderBy: [{ track: "asc" }, { order: "asc" }],
    select: { id: true, code: true, track: true, order: true, maxStripes: true, labelEs: true, labelEn: true },
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
  const branding = await getOrganizationBranding(context);
  const tBelt = await getTranslations("belt");
  const tStatus = await getTranslations("students.status");
  const tPaymentStatus = await getTranslations("students.paymentStatus");
  const locale = await getLocale();

  const canCreate = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  // Enrollment/resume integration plan §7.6: resolved server-side, never from request data. `isEnrollmentBillingActive`
  // wraps `LedgerActivation`, whose only production implementation is unconditionally false — this form renders
  // exactly as it does today, with zero new DOM, for every current organization.
  const billingActive = canCreate ? await isEnrollmentBillingActive(context.organizationId) : false;
  const createStudentPlans = billingActive
    ? (await listSelectablePlans(context.organizationId, Array.isArray(context.academyIds) ? context.academyIds : academies.map((a) => a.id))).map((p) => ({ id: p.id, name: p.name }))
    : [];

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("eyebrow", { orgName: branding.displayName })}</p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("sub", { active: activeCount, inactive: inactiveCount })}
        </p>
      </header>

      {/* Server-side gate is the real enforcement (createStudent itself
          re-checks the role) — this only avoids showing the control to a
          role that would just be rejected, as defense in depth. */}
      {canCreate && (
        <CreateStudentForm
          organizationId={context.organizationId}
          academies={academies}
          rankOptions={createStudentRankOptions}
          billingActive={billingActive}
          plans={createStudentPlans}
          organizationRole={context.organizationRole === "ADMIN" ? "ADMIN" : "DIRECTOR"}
        />
      )}

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

            <label htmlFor="students-track" className="sr-only">
              {t("filters.track")}
            </label>
            <FilterBarSelect id="students-track" name="track" defaultValue={parseTrack(params.track) ?? ""}>
              <option value="">{t("filters.allTracks")}</option>
              <option value={Track.KIDS}>{t("filters.trackKids")}</option>
              <option value={Track.ADULT}>{t("filters.trackAdults")}</option>
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

            {ledgerActive ? (
              // §2.2.1/§3 decision 5: independently-true, overlapping flags — a checkbox per flag, never a single
              // enum select. Any legacy `?payment=` value a bookmark still carries is deliberately NOT submitted by
              // this form (it has its own notice below, outside the form) and is dropped on the next submit.
              <fieldset className="flex flex-wrap items-center gap-3">
                <legend className="sr-only">{t("filters.payment")}</legend>
                {LEDGER_FILTER_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name={key} value="1" defaultChecked={params[key] === "1"} />
                    {t(`ledger.filters.${key}`)}
                  </label>
                ))}
              </fieldset>
            ) : (
              <>
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
              </>
            )}

            {context.organizationRole === "ADMIN" && hasAcademyChoice(academies) && (
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
          {showLegacyBookmarkNotice && <p className="mb-3 text-sm text-muted-foreground">{t("ledger.filters.legacyUnavailable")}</p>}
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
                  // One display shaping for every surface (buildProgressView): an eligible student shows a full
                  // bar with the count capped at the target - never 42 / 30. A time-based degree has no fraction.
                  const progressView = buildProgressView(extra.summary);
                  const progress =
                    progressView.current !== null && progressView.target !== null
                      ? { current: progressView.current, target: progressView.target }
                      : null;
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
                          <ProgressToNextGrade
                            aria-label={`${t("columns.progress")}: ${student.firstName} ${student.lastName}`}
                            current={progress.current}
                            target={progress.target}
                          />
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
                        {ledgerActive ? (
                          (() => {
                            const entry = ledgerDisplayByStudentId.get(student.id);
                            if (!entry || entry.kind === "unavailable") return <RosterLedgerUnavailable t={t} />;
                            return <RosterLedgerStatus display={entry.display} locale={locale} t={t} />;
                          })()
                        ) : (
                          <Pill variant={paymentPillVariant(extra.paymentStatus)}>
                            {paymentStatusLabel(extra.paymentStatus, t, tPaymentStatus)}
                          </Pill>
                        )}
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
