/**
 * The M2 `/fail` body (design §6.5, Format B; owner decision 2026-11-17): at most 100 UTF-8 bytes, so the open-source
 * Healthchecks stores it in its database (not object storage) and its alert email shows it verbatim. ASCII by construction.
 * Example (95 bytes): `URG new=3 rep=1 rem=0 open=2 | A=2 C=0 SLOT=1(x2) RUN=1 F=0 | oldest 2026-12-01T21:00Z | r=7f3a`
 * It never names an academy: categories and counts only. `oldest` is the earliest evidence bound of the problems counted.
 * `open=N` (owner-approved 2026-11-17): how many of the problems represented in THIS email were still unresolved at the
 * monitor's latest observation (this run's persisted state). It is not a live count at send time: a problem can clear or
 * start between the observation and the email. `open=0` means every problem in the email had already cleared (a delayed
 * alert about past problems). The category totals count open and cleared problems alike.
 * When space runs short, `r=` (the run reference) is dropped first, then `oldest`; the totals, `open` and the category
 * counts never are.
 */
export const SUMMARY_MAX_BYTES = 100;

export interface SummaryInput {
  new: number;
  repeat: number;
  reminder: number;
  /** Unresolved (not cleared) at the latest observation, among the problems represented in this email. */
  open: number;
  counts: { A: number; C: number; SLOT: number; RUN: number; F: number };
  /** Missed slots in the longest open SLOT streak counted (shown as `(xN)` when above 1). */
  slotStreak: number;
  oldest: Date | null;
  /** A short reference to this monitor run (hex). */
  runRef: string;
}

const n = (value: number, max = 9999) => (Number.isFinite(value) && value >= 0 ? (value > max ? `${max}+` : String(Math.floor(value))) : "?");
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");

export function encodeSummary(s: SummaryInput): string {
  const c = s.counts;
  const streak = s.slotStreak > 1 ? `(x${n(s.slotStreak, 999)})` : "";
  const core = `URG new=${n(s.new)} rep=${n(s.repeat)} rem=${n(s.reminder)} open=${n(s.open)} | A=${n(c.A)} C=${n(c.C)} SLOT=${n(c.SLOT)}${streak} RUN=${n(c.RUN)} F=${n(c.F)}`;
  const oldest = s.oldest ? ` | oldest ${s.oldest.toISOString().slice(0, 16)}Z` : "";
  const ref = ` | r=${ascii(s.runRef).slice(0, 8)}`;
  for (const candidate of [core + oldest + ref, core + oldest, core]) {
    if (Buffer.byteLength(candidate, "utf8") <= SUMMARY_MAX_BYTES) return candidate;
  }
  return core.slice(0, SUMMARY_MAX_BYTES); // unreachable: the core is at most 98 bytes (every count at "9999+", streak "999+")
}

/** The M1 `/fail` body: monitoring faults and detection failures, codes only, at most 100 UTF-8 bytes. */
export function encodeMonitorFault(parts: string[], runRef: string): string {
  const body = ascii(`MON ${parts.join(" ")} | r=${runRef.slice(0, 8)}`);
  return Buffer.byteLength(body, "utf8") <= SUMMARY_MAX_BYTES ? body : body.slice(0, SUMMARY_MAX_BYTES);
}
