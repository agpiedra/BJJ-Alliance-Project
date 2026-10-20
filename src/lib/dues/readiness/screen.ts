import { prisma } from "@/lib/prisma";
import { runReadOnlySnapshot } from "@/lib/db/read-only-snapshot";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, versionRevision } from "@/lib/dues/config-input";
import { latestEffective } from "@/lib/dues/ledger/common";
import { todayInAsDbDate } from "@/lib/students/status-history";
import { authorizeOwner } from "@/lib/dues/readiness";
import { defaultCandidateMonth, isCandidateMonth } from "@/lib/dues/readiness/candidate";
import { evaluateReadiness, promoStudentIds, type ReadinessReport, type StudentPreview } from "@/lib/dues/readiness/evaluate";
import { openingReviewBinding, pricingAckBinding } from "@/lib/dues/readiness/fingerprint";
import { loadReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Stage 8 PR 8d-1 (docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md §1, M1): what the owner's READ-ONLY readiness screen displays.
 *
 * The report is exactly `evaluateReadiness` over the same snapshot `getDuesReadinessForOwner` loads — same checks, totals,
 * fingerprints and confirmation states. Alongside it, from the SAME REPEATABLE READ, READ ONLY transaction, only what this
 * first screen shows: student and branch names, the content of each ACTIVE opening draft (with its linked legacy month), the
 * legacy rows a check names, and the database time the snapshot was taken.
 *
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §2, M2) adds what the forms need, derived from the SAME snapshot and no
 * new query: each student's review and pricing bindings (from the report's own fingerprints, so a review attests exactly the
 * content displayed beside it), legacy rows, assignment for S and strictly future assignments with their revision tokens, and
 * preview; each branch's local today/current month, whether a baseline taken today can still help S, and its offerable plans;
 * and the baseline counts. Nothing here lets a form name an organization, an actor or a fingerprint.
 *
 * Authorization comes first and is the shared `authorizeOwner` (owner of THIS organization; a non-member's refusal keeps the
 * existing `organization.accessRefused` audit row). Not a "use server" file and not a route: only the 8d page imports it.
 *
 * `afterFirstRead` is a TEST-ONLY pause point passed to the loader (the same convention), never used in production.
 */
export interface ReadinessScreen {
  report: ReadinessReport;
  /** The default candidate (next month, §defaultCandidateMonth) and whether branches disagreed about it. */
  defaultCandidate: YearMonth;
  branchesDisagree: boolean;
  /** `now()` inside the snapshot transaction: the moment the displayed data describes. Later writes are not shown, and not prevented. */
  asOf: Date;
  branches: ScreenBranch[];
  students: ScreenStudent[];
  activeDrafts: {
    id: string;
    studentId: string;
    coverageYear: number;
    coverageMonth: number;
    amount: string;
    currency: string;
    note: string;
    legacyPaymentPeriodId: string | null;
    linkedLegacy: { year: number; month: number; status: string } | null;
  }[];
  /** Only the legacy rows a check or warning names (`legacy:<id>`). */
  legacyRows: Record<string, { studentId: string; year: number; month: number; status: string }>;
  /** Students with no status row at all: what `runStatusHistoryBaseline` would write for (organization-wide, every status). */
  baseline: { total: number; active: number; byBranch: Record<string, number> };
}

export interface ScreenBranch {
  id: string;
  name: string;
  /** `asOf` in this branch's timezone. */
  today: string;
  currentMonth: YearMonth;
  /** A baseline row dated `today` is strictly before the 1st of S, so it can satisfy check 1 for this branch. */
  baselineHelpsS: boolean;
  /** Active, non-package plans of this branch (`isPackagePlan`: no terms covering more than one month), with terms for S. */
  plans: { id: string; name: string; termsForS: { priceAmount: string; currency: string } | null }[];
}

export interface ScreenStudent {
  id: string;
  name: string;
  academyId: string;
  status: string;
  promoOrExempt: boolean;
  /** `openingReviewBinding(S, studentFingerprint)` over THIS snapshot. */
  openingBinding: string;
  /** `pricingAckBinding(...)` over THIS snapshot; promo/exempt students only. */
  pricingBinding: string | null;
  legacyRows: { id: string; year: number; month: number; status: string; amount: string | null; currency: string; promoName: string | null; promoRecurring: boolean }[];
  /** `forS`: the assignment effective for S (`planId: null` = explicit "no plan"), or null when none exists. `future`: strictly
   * after the branch's current month, the only ones `correctAssignment` accepts, with the revision token it checks. */
  assignment: { forS: { planId: string | null; year: number; month: number } | null; future: { id: string; year: number; month: number; planId: string | null; revision: string }[] };
  preview: StudentPreview | null;
}

export type ReadinessScreenResult = { ok: true; screen: ReadinessScreen } | { ok: false; error: "notFound" | "invalid" };

/**
 * `candidate: null` means "the default" (above), computed from this same snapshot's branch timezones and database time.
 */
export async function getReadinessScreenForOwner(
  organizationId: string,
  candidate: YearMonth | null,
  testHooks: { afterFirstRead?: () => Promise<void> } = {},
): Promise<ReadinessScreenResult> {
  if (candidate !== null && !isCandidateMonth(candidate)) return { ok: false, error: "invalid" };
  const ownOrganizationId = await authorizeOwner(organizationId);
  if (ownOrganizationId === null) return { ok: false, error: "notFound" };

  const loaded = await runReadOnlySnapshot(prisma, async (tx) => {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const snapshot = await loadReadinessSnapshot(tx, ownOrganizationId, testHooks);
    const names = await tx.student.findMany({ where: { organizationId: ownOrganizationId }, select: { id: true, firstName: true, lastName: true } });
    const branches = await tx.academy.findMany({ where: { organizationId: ownOrganizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return { now, snapshot, names, branches };
  });

  const { snapshot } = loaded;
  const fallback = defaultCandidateMonth(snapshot.branches.map((b) => b.timezone), loaded.now);
  const s = candidate ?? fallback.month;
  const report = evaluateReadiness(snapshot, { year: s.year, month: s.month });
  const nameOf = new Map(loaded.names.map((s) => [s.id, `${s.firstName} ${s.lastName}`.trim()]));
  const promo = new Set(promoStudentIds(snapshot));
  const legacyById = new Map(snapshot.legacyPayments.map((p) => [p.id, p]));
  const zoneOf = new Map(snapshot.branches.map((b) => [b.id, b.timezone]));
  const branchInfo = new Map(
    snapshot.branches.map((b) => {
      const today = todayInAsDbDate(b.timezone, loaded.now);
      return [b.id, { today: today.toISOString().slice(0, 10), currentMonth: currentMonthIn(b.timezone, loaded.now), baselineHelpsS: today < new Date(Date.UTC(s.year, s.month - 1, 1)) }];
    }),
  );
  const packagePlans = new Set(snapshot.terms.filter((t) => t.monthsCovered > 1).map((t) => t.planId));
  const previewOf = new Map(report.preview.students.map((p) => [p.studentId, p]));
  const withoutHistory = snapshot.students.filter((st) => !snapshot.statusChanges.some((r) => r.studentId === st.id));
  const named = new Set(
    [...report.checks.flatMap((c) => c.items), ...report.warnings.flatMap((w) => w.items)].filter((i) => i.startsWith("legacy:")).map((i) => i.slice(7)),
  );

  return {
    ok: true,
    screen: {
      report,
      defaultCandidate: fallback.month,
      branchesDisagree: fallback.branchesDisagree,
      asOf: loaded.now,
      branches: loaded.branches.map((b) => ({
        ...b,
        ...(branchInfo.get(b.id) ?? { today: "", currentMonth: s, baselineHelpsS: false }),
        plans: snapshot.plans
          .filter((p) => p.academyId === b.id && p.active && !packagePlans.has(p.id))
          .map((p) => {
            const terms = latestEffective(snapshot.terms.filter((t) => t.planId === p.id), s);
            return { id: p.id, name: p.name, termsForS: terms ? { priceAmount: terms.priceAmount, currency: terms.currency } : null };
          })
          .sort((x, y) => x.name.localeCompare(y.name) || (x.id < y.id ? -1 : 1)),
      })),
      students: snapshot.students
        .map((st) => {
          const studentFp = report.fingerprints.students[st.id];
          const branchFp = report.fingerprints.branches[st.homeAcademyId];
          const isPromo = promo.has(st.id);
          const mine = snapshot.assignments.filter((a) => a.studentId === st.id);
          const forS = latestEffective(mine, s);
          const current = currentMonthIn(zoneOf.get(st.homeAcademyId) ?? "UTC", loaded.now);
          return {
            id: st.id,
            name: nameOf.get(st.id) ?? "",
            academyId: st.homeAcademyId,
            status: st.status,
            promoOrExempt: isPromo,
            openingBinding: openingReviewBinding(s, studentFp),
            pricingBinding: isPromo && branchFp ? pricingAckBinding(s, studentFp, branchFp) : null,
            legacyRows: snapshot.legacyPayments
              .filter((p) => p.studentId === st.id)
              .map(({ id, year, month, status, amount, currency, promoName, promoRecurring }) => ({ id, year, month, status, amount, currency, promoName, promoRecurring }))
              .sort((x, y) => x.year - y.year || x.month - y.month),
            assignment: {
              forS: forS ? { planId: forS.planId, year: forS.effectiveYear, month: forS.effectiveMonth } : null,
              future: mine
                .filter((a) => compareYearMonth({ year: a.effectiveYear, month: a.effectiveMonth }, current) > 0)
                .map((a) => ({ id: a.id, year: a.effectiveYear, month: a.effectiveMonth, planId: a.planId, revision: versionRevision({ planId: a.planId }) }))
                .sort((x, y) => x.year - y.year || x.month - y.month),
            },
            preview: previewOf.get(st.id) ?? null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)),
      activeDrafts: snapshot.openingItems
        .map(({ id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }) => {
          const linked = legacyPaymentPeriodId ? legacyById.get(legacyPaymentPeriodId) : undefined;
          return {
            id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId,
            linkedLegacy: linked ? { year: linked.year, month: linked.month, status: linked.status } : null,
          };
        })
        .sort((a, b) => a.coverageYear - b.coverageYear || a.coverageMonth - b.coverageMonth),
      legacyRows: Object.fromEntries(
        [...named].flatMap((id) => {
          const row = legacyById.get(id);
          return row ? [[id, { studentId: row.studentId, year: row.year, month: row.month, status: row.status }]] : [];
        }),
      ),
      baseline: {
        total: withoutHistory.length,
        active: withoutHistory.filter((st) => st.status === "ACTIVE").length,
        byBranch: withoutHistory.reduce<Record<string, number>>((acc, st) => ({ ...acc, [st.homeAcademyId]: (acc[st.homeAcademyId] ?? 0) + 1 }), {}),
      },
    },
  };
}
