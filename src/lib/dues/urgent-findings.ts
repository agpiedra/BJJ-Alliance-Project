import { atRiskKey, type AtRiskEvidence, type GenerationAlertReport } from "@/lib/dues/monthly-generation-alerts";

/**
 * Durable urgent findings (docs/dues/URGENT-ALERTING-ONE-HOUR-PROPOSAL.md §1, revision 5.1; implementation plan PR-A).
 * Written by the monthly-generation run into `JobRun.urgentFindings`, in the SAME finalize update as `status` and
 * `finishedAt`, so a finalized run always has a value and an unfinished run never does. The separate urgent monitor (PR-B)
 * reads them later, so an urgent finding seen at a run's start survives a monitor outage.
 *
 * Three distinguishable states of the column, for PR-B:
 * - an `UrgentFindingsV1` object: what this run established (a clean result has `detection: "ok"`, empty lists, zero errors);
 * - the `UrgentFindingsUnavailableV1` marker: this run's builder failed; nothing is known (PR-B: monitoring fault);
 * - NULL: written by code without this feature (runs before the migration, the weekly digest). On a monthly-generation run
 *   finalized after the monitor began watching, NULL is unexpected (PR-B: monitoring fault).
 *
 * Ids, months, counts, ISO times and safe codes only: never a name, an address, a message or a URL.
 */
export interface UrgentFindingsV1 {
  v: 1;
  /** The job threw: generation's own report is missing. Detection results are kept when detection had finished. */
  thrown?: true;
  /** "ok"; a safe code when detection failed (RUNDET); "notEvaluated" when the run stopped before detecting. */
  detection: string;
  /**
   * Condition A with its EVIDENCE BOUNDS (see `AtRiskEvidence`): `onsetNotBefore` = `T_open + 15 h`; `evidenceAt` = from when the
   * stored data proves A. Neither is "the onset" unless they are equal. Null only when detection came without the detail
   * (test seams).
   */
  newMonthAtRisk: { organizationId: string; year: number; month: number; onsetNotBefore: string | null; evidenceAt: string | null }[];
  /** Condition C; null when detection did not succeed (neither passed nor failed). */
  conditionC: { activatedWithoutProgress: string[]; progressWithoutActivation: string[] } | null;
  /** Run-level errors, from `summarizeMonthlyGenerationRun` (the same loop that feeds the urgent check). */
  runErrors: { global: number; organizations: string[] };
  /** Present only when a list was cut at FINDINGS_LIST_CAP. */
  truncated?: true;
}

/** Stored when the builder itself failed: never NULL, never mistakable for a clean result. */
export interface UrgentFindingsUnavailableV1 {
  v: 1;
  unavailable: "builderFailed";
  /** `safeErrorCode` of the builder's failure. */
  code: string;
}

export type UrgentFindings = UrgentFindingsV1 | UrgentFindingsUnavailableV1;

/** The detection cap (`DETECTION_CAP`): no list can legitimately be longer. */
export const FINDINGS_LIST_CAP = 500;

export interface UrgentFindingsInput {
  /** From `summarizeMonthlyGenerationRun`; a thrown job passes `{ global: 1, organizations: [] }`. */
  runErrors: { global: number; organizations: string[] };
  alerts?: GenerationAlertReport;
  /** From `detectGenerationAlertsDetailed`, keyed by `atRiskKey`. */
  atRisk?: Record<string, AtRiskEvidence>;
  thrown?: boolean;
}

export function unavailableFindings(code: string): UrgentFindingsUnavailableV1 {
  return { v: 1, unavailable: "builderFailed", code };
}

export function buildUrgentFindings({ runErrors, alerts, atRisk = {}, thrown = false }: UrgentFindingsInput): UrgentFindingsV1 {
  let truncated = false;
  const cap = <T>(list: T[]): T[] => {
    if (list.length <= FINDINGS_LIST_CAP) return list;
    truncated = true;
    return list.slice(0, FINDINGS_LIST_CAP);
  };
  const detected = alerts !== undefined && alerts.detection === "ok";

  const findings: UrgentFindingsV1 = {
    v: 1,
    ...(thrown ? { thrown: true as const } : {}),
    detection: alerts ? alerts.detection : "notEvaluated",
    newMonthAtRisk: cap(
      (detected ? alerts.newMonthAtRisk : []).map((m) => {
        const evidence = atRisk[atRiskKey(m)];
        return { organizationId: m.organizationId, year: m.year, month: m.month, onsetNotBefore: evidence?.onsetNotBefore ?? null, evidenceAt: evidence?.evidenceAt ?? null };
      }),
    ),
    conditionC:
      detected && alerts.conditionC
        ? {
            activatedWithoutProgress: cap([...alerts.conditionC.activatedWithoutProgress]),
            progressWithoutActivation: cap([...alerts.conditionC.progressWithoutActivation]),
          }
        : null,
    runErrors: { global: runErrors.global, organizations: cap([...runErrors.organizations]) },
  };
  if (truncated) findings.truncated = true;
  return findings;
}

/**
 * The rule PR-B applies when it rebuilds condition A from stored findings (for example after a monitoring outage): for each
 * A key, the EARLIEST `onsetNotBefore` and the EARLIEST `evidenceAt` over every finding that reported it. A later finding can
 * only add evidence; it never moves a bound later, so repeated unclean passes never make the condition look younger.
 * Unavailable markers and NULLs contribute nothing (PR-B reports them as monitoring faults separately).
 */
export function earliestAtRiskEvidence(findings: (UrgentFindings | null)[]): Record<string, AtRiskEvidence> {
  const earliest: Record<string, AtRiskEvidence> = {};
  const min = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
  for (const f of findings) {
    if (!f || "unavailable" in f) continue;
    for (const m of f.newMonthAtRisk) {
      if (m.onsetNotBefore === null || m.evidenceAt === null) continue;
      const key = atRiskKey(m);
      const seen = earliest[key];
      earliest[key] = seen
        ? { onsetNotBefore: min(seen.onsetNotBefore, m.onsetNotBefore), evidenceAt: min(seen.evidenceAt, m.evidenceAt) }
        : { onsetNotBefore: m.onsetNotBefore, evidenceAt: m.evidenceAt };
    }
  }
  return earliest;
}
