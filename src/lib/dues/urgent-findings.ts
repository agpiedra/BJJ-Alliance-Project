import { atRiskKey, type GenerationAlertReport } from "@/lib/dues/monthly-generation-alerts";

/**
 * The fields of `MonthlyGenerationRunReport` (monthly-generation-progress.ts) this module reads, declared structurally: the
 * visit loop must keep the G2b route module as its only importer (tests/unit/dues-monthly-generation-not-exposed.test.ts).
 */
interface RunErrorsSource {
  visits: { organizationId: string; error?: unknown; rollover?: { inserted: number } | { skipped: string } }[];
  claimErrors: number;
  discoveryError?: string;
}

/**
 * Durable urgent findings (docs/dues/URGENT-ALERTING-ONE-HOUR-PROPOSAL.md §1, revision 5.1; implementation plan PR-A).
 * Written by the monthly-generation run into `JobRun.urgentFindings`, in the SAME finalize update as `status` and
 * `finishedAt`, so a finalized run always has them and an unfinished run never does. The separate urgent monitor (PR-B)
 * reads them later, so an urgent finding seen at a run's start survives a monitor outage.
 *
 * Ids, months, counts and safe codes only: never a name, an address, a message or a URL.
 */
export interface UrgentFindingsV1 {
  v: 1;
  /** The job threw: generation's own report is missing. Detection results are kept when detection had finished. */
  thrown?: true;
  /** "ok"; a safe code when detection failed (RUNDET); "notEvaluated" when the run stopped before detecting. */
  detection: string;
  /**
   * Condition A, with `atRiskSince` (ISO): the earliest time the data read shows A was true (`T_open + 15 h`, or the end of an
   * unclean pass that finished after it). Null only when the detection result came without that detail (test seams).
   */
  newMonthAtRisk: { organizationId: string; year: number; month: number; atRiskSince: string | null }[];
  /** Condition C; null when detection did not succeed (neither passed nor failed). */
  conditionC: { activatedWithoutProgress: string[]; progressWithoutActivation: string[] } | null;
  /**
   * Run-level errors. `global`: claim errors, a discovery error, a thrown job. `organizations`: academies with a visit-stage
   * error or a skipped rollover (sorted, unique). Exactly the errors `summarizeMonthlyGenerationRun` counts as run-level.
   */
  runErrors: { global: number; organizations: string[] };
  /** Present only when a list was cut at FINDINGS_LIST_CAP. */
  truncated?: true;
}

/** The detection cap (`DETECTION_CAP`): no list can legitimately be longer. */
export const FINDINGS_LIST_CAP = 500;

export interface UrgentFindingsInput {
  report?: RunErrorsSource;
  alerts?: GenerationAlertReport;
  /** From `detectGenerationAlertsDetailed`, keyed by `atRiskKey`. */
  atRiskSince?: Record<string, string>;
  thrown?: boolean;
}

export function buildUrgentFindings({ report, alerts, atRiskSince = {}, thrown = false }: UrgentFindingsInput): UrgentFindingsV1 {
  let truncated = false;
  const cap = <T>(list: T[]): T[] => {
    if (list.length <= FINDINGS_LIST_CAP) return list;
    truncated = true;
    return list.slice(0, FINDINGS_LIST_CAP);
  };

  const errorOrganizations = new Set<string>();
  for (const visit of report?.visits ?? []) {
    if (visit.error || (visit.rollover && "skipped" in visit.rollover)) errorOrganizations.add(visit.organizationId);
  }
  const global = (report?.claimErrors ?? 0) + (report?.discoveryError ? 1 : 0) + (thrown ? 1 : 0);
  const detected = alerts !== undefined && alerts.detection === "ok";

  const findings: UrgentFindingsV1 = {
    v: 1,
    ...(thrown ? { thrown: true as const } : {}),
    detection: alerts ? alerts.detection : "notEvaluated",
    newMonthAtRisk: cap(
      (detected ? alerts.newMonthAtRisk : []).map((m) => ({
        organizationId: m.organizationId,
        year: m.year,
        month: m.month,
        atRiskSince: atRiskSince[atRiskKey(m)] ?? null,
      })),
    ),
    conditionC:
      detected && alerts.conditionC
        ? {
            activatedWithoutProgress: cap([...alerts.conditionC.activatedWithoutProgress]),
            progressWithoutActivation: cap([...alerts.conditionC.progressWithoutActivation]),
          }
        : null,
    runErrors: { global, organizations: cap([...errorOrganizations].sort()) },
  };
  if (truncated) findings.truncated = true;
  return findings;
}
