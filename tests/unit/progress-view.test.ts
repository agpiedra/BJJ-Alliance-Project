import { describe, expect, it } from "vitest";
import { buildProgressView, type ProgressViewInput } from "@/lib/promotion/progress-view";

/**
 * One display path for every consumer (staff roster, student page, dashboard,
 * portal, kiosk, analytics). The numbers come from the engine via AtBeltSummary;
 * this only shapes them: an eligible student shows a FULL bar, zero remaining and
 * no overflowing fraction (42 / 30), the real count kept separately.
 */
function input(overrides: Partial<ProgressViewInput> = {}): ProgressViewInput {
  return {
    nextTarget: "STRIPE",
    mode: "ATTENDANCE",
    isEligible: false,
    target: 30,
    percent: 0,
    atBeltCount: 0,
    remainingAttendance: 30,
    timeAnchorMissing: false,
    notConfigured: false,
    dueDate: null,
    reachedOn: null,
    ...overrides,
  };
}

describe("buildProgressView: attendance ranks", () => {
  it("in progress: shows count of target, remaining and the engine percent", () => {
    const view = buildProgressView(input({ atBeltCount: 12, percent: 40, remainingAttendance: 18 }));
    expect(view).toMatchObject({ state: "in_progress", current: 12, target: 30, percent: 40, remaining: 18, actualCount: 12, reachedOn: null });
  });

  it("eligible: full bar, zero remaining, the displayed count is capped at the target, the real count is kept separately", () => {
    const view = buildProgressView(
      input({ isEligible: true, atBeltCount: 42, percent: 100, remainingAttendance: 0, reachedOn: "2026-03-12" }),
    );
    expect(view).toMatchObject({ state: "eligible", current: 30, target: 30, percent: 100, remaining: 0, actualCount: 42, reachedOn: "2026-03-12" });
  });

  it("legacy belt-exam eligibility (engine remaining = null) still reports remaining 0, never null", () => {
    const view = buildProgressView(input({ nextTarget: "BELT", isEligible: true, target: 150, atBeltCount: 151, percent: 100, remainingAttendance: null }));
    expect(view).toMatchObject({ state: "eligible", current: 150, target: 150, remaining: 0, actualCount: 151 });
  });

  it("a negative legacy count never yields a negative or NaN display", () => {
    const view = buildProgressView(input({ atBeltCount: -10, percent: 0, remainingAttendance: 40 }));
    expect(view).toMatchObject({ state: "in_progress", current: 0, percent: 0, remaining: 40, actualCount: -10 });
  });

  it("a count of zero after a promotion shows 0 of the next target", () => {
    const view = buildProgressView(input({ atBeltCount: 0, percent: 0, remainingAttendance: 30 }));
    expect(view).toMatchObject({ state: "in_progress", current: 0, target: 30, percent: 0 });
  });

  it("never returns NaN, Infinity or undefined numbers", () => {
    for (const view of [
      buildProgressView(input({ target: 0, atBeltCount: 5, percent: null, remainingAttendance: 0 })),
      buildProgressView(input({ target: null, percent: null, remainingAttendance: null })),
    ]) {
      for (const value of [view.current, view.target, view.percent, view.remaining]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("no attendance target and nothing else to say is 'none'", () => {
    expect(buildProgressView(input({ target: null, percent: null, remainingAttendance: null })).state).toBe("none");
  });

  it("nothing next (final degree) is 'none'", () => {
    expect(buildProgressView(input({ nextTarget: "NONE", target: null })).state).toBe("none");
  });

  it("MANUAL shows the next target with no numbers and is never eligible", () => {
    const view = buildProgressView(input({ mode: "MANUAL", target: null, percent: null, remainingAttendance: null }));
    expect(view).toMatchObject({ state: "manual", nextTarget: "STRIPE", current: null, target: null, percent: null, remaining: null });
  });
});

describe("buildProgressView: time-based ranks (black belt)", () => {
  const due = new Date("2029-03-10T12:00:00Z");
  const time = (overrides: Partial<ProgressViewInput> = {}) =>
    input({ mode: "TIME", target: null, remainingAttendance: null, percent: 20, atBeltCount: 80, dueDate: due, ...overrides });

  it("pending: a due date and a percent, no attendance denominator, actual attendance kept", () => {
    const view = buildProgressView(time());
    expect(view).toMatchObject({ state: "time_pending", dueDate: due, percent: 20, current: null, target: null, remaining: null, actualCount: 80 });
  });

  it("due: eligible with the due date, still no attendance fraction", () => {
    const view = buildProgressView(time({ isEligible: true, percent: 100 }));
    expect(view).toMatchObject({ state: "eligible", dueDate: due, percent: 100, current: null, target: null });
  });

  it("unknown last-award date: no due date and no percent, attendance still shown", () => {
    const view = buildProgressView(time({ timeAnchorMissing: true, dueDate: null, percent: null }));
    expect(view).toMatchObject({ state: "time_anchor_missing", dueDate: null, percent: null, actualCount: 80 });
  });

  it("a degree with no configured interval is 'not_configured', never eligible and never 'none'", () => {
    const view = buildProgressView(time({ notConfigured: true, dueDate: null, percent: null }));
    expect(view.state).toBe("not_configured");
  });
});
