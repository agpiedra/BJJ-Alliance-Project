import { describe, expect, it } from "vitest";
import { checkSchedule, judgeSlots, slotKey, slotsDue, streakOps, SLOT_DEADLINE_MS, MAX_SLOTS_PER_RUN } from "../../src/lib/monitoring/urgent/slots";

/** PR-B B-U1–B-U5: billing slots owed, judged and deduplicated. Pure; fixed clocks. */
const t = (iso: string) => new Date(iso);
const MIN = 60_000;

describe("checkSchedule (B-U1)", () => {
  it("only `0 */3 * * *` is supported; anything else is a monitoring fault, never a guess", () => {
    expect(checkSchedule("0 */3 * * *")).toEqual({ ok: true });
    expect(checkSchedule("  0 */3 * * *  ")).toEqual({ ok: true });
    expect(checkSchedule(null)).toEqual({ ok: false, reason: "missing" });
    expect(checkSchedule(undefined)).toEqual({ ok: false, reason: "missing" });
    for (const other of ["0 */2 * * *", "0 */3 * * 1", "7 */3 * * *", "0 0,3,6,9,12,15,18,21 * * *", ""]) {
      expect(checkSchedule(other)).toEqual({ ok: false, reason: "unsupported" });
    }
  });
});

describe("slotsDue (B-U2, B-U3)", () => {
  it("S == watchingSince is owed; a slot before watchingSince is not", () => {
    expect(slotsDue({ watchingSince: t("2031-11-02T03:00:00Z"), checkedThrough: null, dbNow: t("2031-11-02T03:10:00Z") })).toEqual([t("2031-11-02T03:00:00Z")]);
    expect(slotsDue({ watchingSince: t("2031-11-02T03:00:00.001Z"), checkedThrough: null, dbNow: t("2031-11-02T06:10:00Z") })).toEqual([t("2031-11-02T06:00:00Z")]);
  });

  it("a slot is judged exactly when its deadline S + 10 min has passed, not 1 ms earlier", () => {
    const base = { watchingSince: t("2031-11-02T00:00:00Z"), checkedThrough: t("2031-11-02T00:00:00Z") };
    expect(slotsDue({ ...base, dbNow: new Date(t("2031-11-02T03:00:00Z").getTime() + SLOT_DEADLINE_MS) })).toEqual([t("2031-11-02T03:00:00Z")]);
    expect(slotsDue({ ...base, dbNow: new Date(t("2031-11-02T03:00:00Z").getTime() + SLOT_DEADLINE_MS - 1) })).toEqual([]);
  });

  it("slots at or before the checkpoint are never judged again (checkpoint preserved)", () => {
    expect(slotsDue({ watchingSince: t("2031-11-01T00:00:00Z"), checkedThrough: t("2031-11-02T03:00:00Z"), dbNow: t("2031-11-02T09:30:00Z") })).toEqual([
      t("2031-11-02T06:00:00Z"),
      t("2031-11-02T09:00:00Z"),
    ]);
  });

  it("across midnight and a month end; a 7-day gap after an outage gives all 56 slots in order", () => {
    expect(slotsDue({ watchingSince: t("2031-11-30T20:00:00Z"), checkedThrough: null, dbNow: t("2031-12-01T03:10:00Z") })).toEqual([
      t("2031-11-30T21:00:00Z"),
      t("2031-12-01T00:00:00Z"),
      t("2031-12-01T03:00:00Z"),
    ]);
    const week = slotsDue({ watchingSince: t("2031-11-01T00:00:00Z"), checkedThrough: t("2031-11-01T21:00:00Z"), dbNow: new Date(t("2031-11-08T21:00:00Z").getTime() + 10 * MIN) });
    expect(week).toHaveLength(56);
    expect(week[0]).toEqual(t("2031-11-02T00:00:00Z"));
    expect(week[55]).toEqual(t("2031-11-08T21:00:00Z"));
  });

  it("at most MAX_SLOTS_PER_RUN per run; the rest are left for the next run (none skipped)", () => {
    const slots = slotsDue({ watchingSince: t("2030-01-01T00:00:00Z"), checkedThrough: null, dbNow: t("2031-11-01T00:00:00Z") });
    expect(slots).toHaveLength(MAX_SLOTS_PER_RUN);
    expect(slotsDue({ watchingSince: t("2030-01-01T00:00:00Z"), checkedThrough: slots.at(-1)!, dbNow: t("2031-11-01T00:00:00Z") })[0].getTime()).toBe(slots.at(-1)!.getTime() + 3 * 60 * MIN);
  });
});

describe("judgeSlots (B-U4)", () => {
  const S = t("2031-11-02T03:00:00Z");
  const at = (offsetMin: number) => new Date(S.getTime() + offsetMin * MIN);
  it("window edges: started at S kept; started at S + 10 min missed; finished exactly at S + 10 min kept; unfinished missed", () => {
    expect(judgeSlots([S], [{ startedAt: at(0), finishedAt: at(5) }])).toEqual([{ slot: S, kept: true }]);
    expect(judgeSlots([S], [{ startedAt: at(10), finishedAt: at(12) }])).toEqual([{ slot: S, kept: false }]);
    expect(judgeSlots([S], [{ startedAt: at(1), finishedAt: at(10) }])).toEqual([{ slot: S, kept: true }]);
    expect(judgeSlots([S], [{ startedAt: at(1), finishedAt: new Date(at(10).getTime() + 1) }])).toEqual([{ slot: S, kept: false }]);
    expect(judgeSlots([S], [{ startedAt: at(1), finishedAt: null }])).toEqual([{ slot: S, kept: false }]);
    expect(judgeSlots([S], [{ startedAt: new Date(S.getTime() - 1), finishedAt: at(2) }])).toEqual([{ slot: S, kept: false }]);
  });
  it("duplicate deliveries in one window count once; a run in the next window counts for the next slot only", () => {
    const next = new Date(S.getTime() + 3 * 60 * MIN);
    const runs = [
      { startedAt: at(0), finishedAt: at(3) },
      { startedAt: at(1), finishedAt: at(4) },
      { startedAt: new Date(next.getTime() + MIN), finishedAt: new Date(next.getTime() + 4 * MIN) },
    ];
    expect(judgeSlots([S, next], runs)).toEqual([
      { slot: S, kept: true },
      { slot: next, kept: true },
    ]);
  });
});

describe("streakOps (B-U5)", () => {
  const s = (h: number) => t(`2031-11-02T${String(h).padStart(2, "0")}:00:00Z`);
  it("miss with none open: insert; miss with one open: extend; kept: clear; miss after clear: a new key", () => {
    expect(streakOps(null, [{ slot: s(0), kept: false }])).toEqual([{ op: "insert", key: slotKey(s(0)), slot: s(0) }]);
    expect(streakOps("SLOT:open", [{ slot: s(3), kept: false }])).toEqual([{ op: "extend", key: "SLOT:open", slot: s(3) }]);
    expect(streakOps("SLOT:open", [{ slot: s(3), kept: true }])).toEqual([{ op: "clear", key: "SLOT:open" }]);
    expect(streakOps(null, [{ slot: s(3), kept: true }])).toEqual([]);
  });
  it("miss, miss, kept, miss: one streak of two, cleared, then a new streak", () => {
    expect(
      streakOps(null, [
        { slot: s(0), kept: false },
        { slot: s(3), kept: false },
        { slot: s(6), kept: true },
        { slot: s(9), kept: false },
      ]),
    ).toEqual([
      { op: "insert", key: "SLOT:2031-11-02T00:00Z", slot: s(0) },
      { op: "extend", key: "SLOT:2031-11-02T00:00Z", slot: s(3) },
      { op: "clear", key: "SLOT:2031-11-02T00:00Z" },
      { op: "insert", key: "SLOT:2031-11-02T09:00Z", slot: s(9) },
    ]);
  });
});
