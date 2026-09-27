import { describe, expect, it } from "vitest";
import { eligibleAndAssigned, type AssignmentRow, type StatusHistoryRow } from "../../src/lib/dues/eligibility";

/**
 * Eligibility-prerequisites brief, section 6.2: the pure function the (not-yet-built) monthly job will call. No database, no
 * clock, no caller in this PR. Every case here mirrors a worked example from section 3.3, by name.
 */
const row = (year: number, month: number, day: number, sequence: number, status: "ACTIVE" | "INACTIVE" | "PENDING" | "ARCHIVED"): StatusHistoryRow => ({
  effectiveOn: { year, month, day },
  sequence,
  status,
});
const assignment = (year: number, month: number, planId: string | null, planAcademyId: string | null = "branch-1"): AssignmentRow => ({
  effectiveYear: year,
  effectiveMonth: month,
  planId,
  planAcademyId,
});
const OCT = { year: 2030, month: 10 };
const NOV = { year: 2030, month: 11 };
const SEP = { year: 2030, month: 9 };
const ACADEMY = "branch-1";

describe("eligibleAndAssigned: the four outcomes", () => {
  it("UNDECIDABLE — no status history row strictly before the month's 1st", () => {
    expect(eligibleAndAssigned([], [], ACADEMY, OCT)).toEqual({ outcome: "UNDECIDABLE" });
    expect(eligibleAndAssigned([row(2030, 10, 1, 1, "ACTIVE")], [], ACADEMY, OCT)).toEqual({ outcome: "UNDECIDABLE" }); // same-day, fails strict `<`
  });

  it("NOT_ELIGIBLE — latest qualifying status is not ACTIVE", () => {
    const history = [row(2030, 9, 5, 1, "INACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "NOT_ELIGIBLE" });
  });

  it("NO_ASSIGNMENT — eligible status but no assignment row on or before the month", () => {
    const history = [row(2030, 9, 5, 1, "ACTIVE")];
    expect(eligibleAndAssigned(history, [], ACADEMY, OCT)).toEqual({ outcome: "NO_ASSIGNMENT" });
  });

  it("NO_ASSIGNMENT — the latest assignment's planId is explicitly null", () => {
    const history = [row(2030, 9, 5, 1, "ACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, null)], ACADEMY, OCT)).toEqual({ outcome: "NO_ASSIGNMENT" });
  });

  it("ELIGIBLE — with the latest assignment's planId", () => {
    const history = [row(2030, 9, 5, 1, "ACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
  });

  it("NO_ASSIGNMENT — the latest assignment's plan belongs to a different branch (5.4's defensive, unreachable-today check)", () => {
    const history = [row(2030, 9, 5, 1, "ACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a", "other-branch")], ACADEMY, OCT)).toEqual({ outcome: "NO_ASSIGNMENT" });
  });
});

describe("eligibleAndAssigned: worked examples from 3.3", () => {
  it("1. pause on the 1st: that month remains billable", () => {
    // ACTIVE through August (some qualifying row before Sep 1); paused effective Oct 1.
    const history = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 10, 1, 2, "INACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
    // November's cutoff DOES see the Oct 1 pause.
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, NOV)).toEqual({ outcome: "NOT_ELIGIBLE" });
  });

  it("2. pause later in the month (Oct 25): same result as pause on the 1st", () => {
    const history = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 10, 25, 2, "INACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, NOV)).toEqual({ outcome: "NOT_ELIGIBLE" });
  });

  it("3. pause then resume, same month: nets to zero effect on any month", () => {
    const history = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 9, 5, 2, "INACTIVE"), row(2030, 9, 20, 3, "ACTIVE")];
    // September itself is decided by August's status (neither Sep row qualifies for September's own `< Sep 1` cutoff).
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, SEP)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
    // October sees both September rows; the later one (the resume) wins.
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
  });

  it("4. multiple status changes on the same day: sequence, not insertion order in the array, decides", () => {
    const pauseWins = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 9, 20, 3, "PENDING"), row(2030, 9, 20, 2, "INACTIVE")];
    // sequence 3 (PENDING) is the later one even though it is listed after sequence 2 — order in the array must not matter.
    expect(eligibleAndAssigned(pauseWins, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "NOT_ELIGIBLE" });

    const resumeWins = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 9, 20, 2, "INACTIVE"), row(2030, 9, 20, 3, "ACTIVE")];
    expect(eligibleAndAssigned(resumeWins, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
  });

  it("5. delayed generation matches on-time generation: the function reads no clock, so nothing distinguishes 'asked late'", () => {
    const history = [row(2030, 8, 15, 1, "ACTIVE"), row(2030, 10, 10, 2, "INACTIVE")]; // paused mid-October, after October's own cutoff
    const assignments = [assignment(2030, 1, "plan-a")];
    // October's answer is fixed by rows dated before Oct 1 only; the Oct 10 pause cannot reach it, whether this is "asked" once or many times.
    const onTime = eligibleAndAssigned(history, assignments, ACADEMY, OCT);
    const askedAgain = eligibleAndAssigned(history, assignments, ACADEMY, OCT);
    expect(onTime).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
    expect(askedAgain).toEqual(onTime);
  });
});

describe("eligibleAndAssigned: the strict `<` boundary itself", () => {
  it("a status change dated exactly G(month) does not affect month, only month + 1", () => {
    const history = [row(2030, 9, 1, 1, "ACTIVE"), row(OCT.year, OCT.month, 1, 2, "INACTIVE")];
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, OCT)).toEqual({ outcome: "ELIGIBLE", planId: "plan-a" });
    expect(eligibleAndAssigned(history, [assignment(2030, 1, "plan-a")], ACADEMY, NOV)).toEqual({ outcome: "NOT_ELIGIBLE" });
  });
});
