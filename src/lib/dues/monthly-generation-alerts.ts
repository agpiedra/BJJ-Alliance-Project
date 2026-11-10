import { DateTime } from "luxon";
import { safeErrorCode } from "@/lib/auth/password-reset-log";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { readGenerationAlertState, type GenerationAlertState } from "@/lib/tenant/platform-lookups";
import type { AlertSignals } from "@/lib/jobs/run-scheduled-job";

/**
 * Monthly-generation alert detection (docs/dues/MONTHLY-GENERATION-ALERTING-PLAN.md §6; decisions in
 * docs/dues/D5-SCHEDULING-DECISION-BRIEF.md §5–§6). One bounded read at run start, then a pure evaluation:
 * - A (urgent): the organization's new month (`current_min`) has no row, no finished pass, or an unclean last pass, at or after
 *   T_open + 15 h. T_open is when the LAST of its branches reached local midnight on the 1st.
 * - B (data): a month before `current_min` whose last finished pass was not clean, or which never finished a pass.
 * - C (urgent, stage 9 PR 9-3; plan PR 9-3 "Condition C"): an organization with an effective activation and NO progress row at
 *   all, or progress rows for an organization with NO effective activation. The switch inserts the first row in its own
 *   transaction (database-checked at commit) and progress rows are never deleted (trigger), so C can only mean a manual database
 *   edit or an activation bug: an invariant failure, reported at once, for every organization whatever its status. It is NOT
 *   "billing not finished" — a row that exists without a clean pass 15 h after its month opened stays condition A.
 * - D (urgent): detection itself failed (a database error or timeout, a list over its cap, an organization with no branch, an
 *   unknown timezone). Unknown state is a failure, never "nothing to report".
 * - Workload review thresholds: a separate alert that never counts as a billing failure.
 * A, B and D are evaluated for ACTIVE organizations only: the visit gate refuses any other, so it owes no billing and is
 * listed in `notActiveOrganizations` instead (its rows still count toward the workload thresholds).
 *
 * Wording (trigger plan §3, §8): these say what the LAST FINISHED PASS observed. A clean pass is not proof that a month is
 * complete now, and none of this certifies billing completeness. Ids, months, reason codes and counts only.
 */

export const NEW_MONTH_WARNING_MS = 15 * 60 * 60 * 1000;
export const WORKLOAD_THRESHOLDS = {
  /** Reached at >= 50. The rest are reached when EXCEEDED. */
  progressRows: 50,
  organizations: 4,
  studentsPerOrganization: 100,
  studentsTotal: 280,
  branchesPerOrganization: 2,
} as const;
/** Rows read before detection gives up as D: 10x the review threshold. */
export const DETECTION_CAP = 500;
export const DETECTION_BOUNDS = { maxWaitMs: 1_000, timeoutMs: 2_000, statementTimeoutMs: 1_000, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 1_000 };
/** The read's worst case, reserved by the route budget (`preRunnerReadMs`): maxWait + timeout + the statement in flight. */
export const DETECTION_READ_WORST_MS = DETECTION_BOUNDS.maxWaitMs + DETECTION_BOUNDS.timeoutMs + DETECTION_BOUNDS.statementTimeoutMs;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export type WorkloadReason = "progressRows" | "organizations" | "studentsPerOrganization" | "studentsTotal" | "branchesPerOrganization" | "unalignedTimezone";
export interface OrganizationMonth {
  organizationId: string;
  year: number;
  month: number;
}
export interface GenerationAlertReport {
  /** "ok", or why detection failed (condition D). */
  detection: string;
  newMonthAtRisk: OrganizationMonth[];
  olderMonthNotClean: OrganizationMonth[];
  /**
   * Organizations with progress rows whose status is not ACTIVE. The visit gate refuses them, so no billing is owed and A/B
   * are not evaluated for them (otherwise one suspended organization would hold the urgent check down forever and mask every
   * later urgent problem). Their rows still count toward the workload thresholds: discovery still revisits them.
   */
  notActiveOrganizations: string[];
  /** Null when detection failed (D): nothing was evaluated, so C is neither passed nor failed. */
  conditionC: { activatedWithoutProgress: string[]; progressWithoutActivation: string[] } | null;
  workload: {
    reasons: WorkloadReason[];
    counts: { progressRows: number; organizations: number; maxStudentsPerOrganization: number; studentsTotal: number; maxBranchesPerOrganization: number };
  } | null;
}

const failed = (detection: string): GenerationAlertReport => ({
  detection,
  newMonthAtRisk: [],
  olderMonthNotClean: [],
  notActiveOrganizations: [],
  conditionC: null,
  workload: null,
});

/** Local midnight on the 1st of `m` in `zone`, as epoch ms (NaN for an unknown zone). */
function monthOpensAt(m: YearMonth, zone: string): number {
  return DateTime.fromObject({ year: m.year, month: m.month, day: 1 }, { zone }).toMillis();
}

export function evaluateGenerationAlerts(state: GenerationAlertState, now: Date): GenerationAlertReport {
  if (state.overflow) return failed("overflow");
  const zones = new Map<string, string[]>();
  for (const b of state.branches) zones.set(b.organizationId, [...(zones.get(b.organizationId) ?? []), b.timezone]);
  const rowsByOrganization = new Map<string, GenerationAlertState["progress"]>();
  for (const row of state.progress) rowsByOrganization.set(row.organizationId, [...(rowsByOrganization.get(row.organizationId) ?? []), row]);

  const status = new Map(state.organizations.map((o) => [o.organizationId, o.status]));
  const newMonthAtRisk: OrganizationMonth[] = [];
  const olderMonthNotClean: OrganizationMonth[] = [];
  const notActiveOrganizations: string[] = [];
  let unaligned = false;
  for (const [organizationId, rows] of rowsByOrganization) {
    const branchZones = zones.get(organizationId) ?? [];
    // An organization missing from the status list is treated as ACTIVE (alert rather than stay silent).
    const active = (status.get(organizationId) ?? "ACTIVE") === "ACTIVE";
    // Only an ACTIVE organization's broken configuration is a detection failure (D); a non-ACTIVE one owes no billing.
    if (branchZones.length === 0) {
      if (active) return failed("noBranches");
      notActiveOrganizations.push(organizationId);
      continue;
    }
    let currentMin: YearMonth;
    let opensAt: number;
    try {
      currentMin = branchZones.map((z) => currentMonthIn(z, now)).reduce((min, m) => (compareYearMonth(m, min) < 0 ? m : min));
      const openings = branchZones.map((z) => monthOpensAt(currentMin, z));
      if (openings.some((t) => !Number.isFinite(t))) throw new RangeError("invalid timezone");
      opensAt = Math.max(...openings);
      // Aligned = the branch's month opening falls on a `0 */3 * * *` UTC slot (Costa Rica: 06:00 UTC).
      if (openings.some((t) => t % THREE_HOURS_MS !== 0)) unaligned = true;
    } catch {
      if (active) return failed("invalidTimezone");
      notActiveOrganizations.push(organizationId);
      continue;
    }

    if (!active) {
      notActiveOrganizations.push(organizationId);
      continue;
    }
    const notClean = (r: GenerationAlertState["progress"][number]) => r.lastPassCompletedAt === null || r.lastPassClean !== true;
    const earliest = rows.reduce((min, r) => (compareYearMonth(r, min) < 0 ? r : min));
    const current = rows.find((r) => compareYearMonth(r, currentMin) === 0);
    // A month before the organization's first row (its start month S) is never owed, so it cannot be at risk.
    if (now.getTime() >= opensAt + NEW_MONTH_WARNING_MS && compareYearMonth(earliest, currentMin) <= 0 && (!current || notClean(current))) {
      newMonthAtRisk.push({ organizationId, ...currentMin });
    }
    for (const r of rows) {
      if (compareYearMonth(r, currentMin) < 0 && notClean(r)) olderMonthNotClean.push({ organizationId, year: r.year, month: r.month });
    }
  }

  const studentCounts = state.students.map((s) => s.count);
  const counts = {
    progressRows: state.progress.length,
    organizations: rowsByOrganization.size,
    maxStudentsPerOrganization: Math.max(0, ...studentCounts),
    studentsTotal: studentCounts.reduce((a, b) => a + b, 0),
    maxBranchesPerOrganization: Math.max(0, ...[...rowsByOrganization.keys()].map((id) => zones.get(id)?.length ?? 0)),
  };
  const t = WORKLOAD_THRESHOLDS;
  const reasons: WorkloadReason[] = [];
  if (counts.progressRows >= t.progressRows) reasons.push("progressRows");
  if (counts.organizations > t.organizations) reasons.push("organizations");
  if (counts.maxStudentsPerOrganization > t.studentsPerOrganization) reasons.push("studentsPerOrganization");
  if (counts.studentsTotal > t.studentsTotal) reasons.push("studentsTotal");
  if (counts.maxBranchesPerOrganization > t.branchesPerOrganization) reasons.push("branchesPerOrganization");
  if (unaligned) reasons.push("unalignedTimezone");

  const activated = new Set(state.activatedOrganizations);
  const conditionC = {
    activatedWithoutProgress: [...activated].filter((id) => !rowsByOrganization.has(id)).sort(),
    progressWithoutActivation: [...rowsByOrganization.keys()].filter((id) => !activated.has(id)).sort(),
  };
  return { detection: "ok", newMonthAtRisk, olderMonthNotClean, notActiveOrganizations, conditionC, workload: { reasons, counts } };
}

/** The bounded read plus the evaluation. Never throws: any read failure becomes condition D with a safe code. */
export async function detectGenerationAlerts(now: Date, read: typeof readGenerationAlertState = readGenerationAlertState): Promise<GenerationAlertReport> {
  let state: GenerationAlertState;
  try {
    state = await read(DETECTION_CAP, DETECTION_BOUNDS);
  } catch (error) {
    return failed(safeErrorCode(error));
  }
  return evaluateGenerationAlerts(state, now);
}

/**
 * Which ping each alert check gets. With detection failed (D), only urgent is evaluated (`/fail`); the others are not sent.
 * `runLevelErrors`: claim, discovery, visit-stage and skipped-rollover errors of THIS run (urgent). Condition C is urgent too.
 */
export function alertSignalsFor(report: GenerationAlertReport, runLevelErrors: number): AlertSignals {
  if (report.detection !== "ok" || report.workload === null || report.conditionC === null) return { urgent: false };
  const c = report.conditionC.activatedWithoutProgress.length + report.conditionC.progressWithoutActivation.length;
  return {
    urgent: report.newMonthAtRisk.length === 0 && runLevelErrors === 0 && c === 0,
    data: report.olderMonthNotClean.length === 0,
    workload: report.workload.reasons.length === 0,
  };
}
