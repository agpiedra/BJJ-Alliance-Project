import { prisma } from "@/lib/prisma";
import { runReadOnlySnapshot } from "@/lib/db/read-only-snapshot";
import type { YearMonth } from "@/lib/dues/calendar";
import { authorizeOwner } from "@/lib/dues/readiness";
import { defaultCandidateMonth, isCandidateMonth } from "@/lib/dues/readiness/candidate";
import { evaluateReadiness, promoStudentIds, type ReadinessReport } from "@/lib/dues/readiness/evaluate";
import { loadReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Stage 8 PR 8d-1 (docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md §1, M1): what the owner's READ-ONLY readiness screen displays.
 *
 * The report is exactly `evaluateReadiness` over the same snapshot `getDuesReadinessForOwner` loads — same checks, totals,
 * fingerprints and confirmation states. Alongside it, from the SAME REPEATABLE READ, READ ONLY transaction, only what this
 * first screen shows: student and branch names, the content of each ACTIVE opening draft (with its linked legacy month), the
 * legacy rows a check names, and the database time the snapshot was taken. Form-only payloads (bindings, plan lists, legacy
 * rows for a link picker) are deliberately absent until the interactive PR needs them.
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
  branches: { id: string; name: string }[];
  students: { id: string; name: string; academyId: string; status: string; promoOrExempt: boolean }[];
  activeDrafts: {
    id: string;
    studentId: string;
    coverageYear: number;
    coverageMonth: number;
    amount: string;
    currency: string;
    note: string;
    linkedLegacy: { year: number; month: number; status: string } | null;
  }[];
  /** Only the legacy rows a check or warning names (`legacy:<id>`). */
  legacyRows: Record<string, { studentId: string; year: number; month: number; status: string }>;
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
      branches: loaded.branches,
      students: snapshot.students
        .map((s) => ({ id: s.id, name: nameOf.get(s.id) ?? "", academyId: s.homeAcademyId, status: s.status, promoOrExempt: promo.has(s.id) }))
        .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)),
      activeDrafts: snapshot.openingItems
        .map(({ id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }) => {
          const linked = legacyPaymentPeriodId ? legacyById.get(legacyPaymentPeriodId) : undefined;
          return {
            id, studentId, coverageYear, coverageMonth, amount, currency, note,
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
    },
  };
}
