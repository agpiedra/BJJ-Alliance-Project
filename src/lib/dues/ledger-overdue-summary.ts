import type { StudentStatus } from "@/generated/prisma/client";
import { toRosterLedgerDisplay, type RosterPaymentFact } from "@/lib/dues/roster-payment-facts-queries";

/** Bounded name list for a stat tile's/digest's context line — avoids blowing out a fixed-height tile or an
 * email body with a large roster. Extracted from dashboard/page.tsx (REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1,
 * PR 3) so the weekly digest (PR 4) reuses the identical cap/overflow behavior rather than redefining it. */
export function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max).join(", ");
  const remaining = names.length - max;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}

export type LedgerOverdueSummary = {
  monthlyPastGraceCount: number;
  monthlyPastGraceNote: string;
  signupPastDueCount: number;
  signupPastDueNote: string;
  /** A failed read contributes here ONLY — never silently folded into either count above, never treated as
   * "no debt" (REMAINING-LEDGER-CONSUMERS-BRIEF.md §6.2's approved partial-read-failure policy). */
  unknownCount: number;
};

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1/Decision 1/Decision 2 (dashboard overdue panel + §1.2 weekly digest,
 * PR 3/PR 4): two independent counts — `monthlyPastGrace` and `signupPastDue` — a student can appear in BOTH
 * (never deduplicated into one "unique affected students" total, never summed together into one number). The
 * population this is called over includes inactive/archived students with qualifying old debt (Decision 2);
 * their status is labeled in the joined-names note whenever it is not `"ACTIVE"`, never presented
 * indistinguishably from an active student's debt. Pure — no I/O — so the real batched read
 * (`listRosterPaymentFacts`) and this aggregation are two separately verifiable steps, mirroring
 * `toRosterLedgerDisplay`'s own pure-function precedent. `tStatus` is a translator for display callers
 * (dashboard); a caller with no per-recipient locale yet (the digest, rendered later per-recipient by
 * `renderNotificationMessage`) passes the identity function and simply never reads the `*Note` fields.
 */
export function summarizeLedgerOverdue(
  students: Array<{ id: string; firstName: string; lastName: string; status: StudentStatus }>,
  byStudentId: Map<string, RosterPaymentFact>,
  tStatus: (status: string) => string,
): LedgerOverdueSummary {
  const monthlyNames: string[] = [];
  const signupNames: string[] = [];
  let unknownCount = 0;

  for (const student of students) {
    const fact = byStudentId.get(student.id);
    if (!fact?.ok) {
      unknownCount++;
      continue;
    }
    const display = toRosterLedgerDisplay(fact.facts, fact.todayIso);
    const label =
      student.status === "ACTIVE" ? `${student.firstName} ${student.lastName}` : `${student.firstName} ${student.lastName} (${tStatus(student.status)})`;
    if (display.flags.monthlyPastGrace) monthlyNames.push(label);
    if (display.flags.signupPastDue) signupNames.push(label);
  }

  return {
    monthlyPastGraceCount: monthlyNames.length,
    monthlyPastGraceNote: joinNames(monthlyNames),
    signupPastDueCount: signupNames.length,
    signupPastDueNote: joinNames(signupNames),
    unknownCount,
  };
}
