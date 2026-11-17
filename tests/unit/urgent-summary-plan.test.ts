import { describe, expect, it } from "vitest";
import { encodeMonitorFault, encodeSummary, SUMMARY_MAX_BYTES, type SummaryInput } from "../../src/lib/monitoring/urgent/summary";
import { planM2, REMINDER_INTERVAL_MS } from "../../src/lib/monitoring/urgent/plan";
import type { KeyRow } from "../../src/lib/monitoring/urgent/keys";

/** PR-B B-U9–B-U15: the ≤ 100-byte UTF-8 summary and the M2 decision table (repeats, reminders, combined alerts). */
const t = (iso: string) => new Date(iso);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("encodeSummary (B-U9–B-U11)", () => {
  const example: SummaryInput = {
    new: 3,
    repeat: 1,
    reminder: 0,
    counts: { A: 2, C: 0, SLOT: 1, RUN: 1, F: 0 },
    slotStreak: 2,
    oldest: t("2026-12-01T21:00:00Z"),
    runRef: "7f3a",
  };

  it("B-U9: the design example, exactly, 88 bytes", () => {
    const s = encodeSummary(example);
    expect(s).toBe("URG new=3 rep=1 rem=0 | A=2 C=0 SLOT=1(x2) RUN=1 F=0 | oldest 2026-12-01T21:00Z | r=7f3a");
    expect(bytes(s)).toBe(88);
  });

  it("B-U10: when space runs short, r= is dropped first, then oldest; the totals and category counts never", () => {
    // Core 65 bytes: core + oldest = 92 fits, + r= = 101 does not → only r= is dropped.
    const mid = encodeSummary({ ...example, new: 9999, repeat: 9999, reminder: 9999, counts: { A: 99, C: 99, SLOT: 9, RUN: 99, F: 99 } });
    expect(mid).toBe("URG new=9999 rep=9999 rem=9999 | A=99 C=99 SLOT=9(x2) RUN=99 F=99 | oldest 2026-12-01T21:00Z");
    expect(bytes(mid)).toBe(92);
    // Core 78 bytes: core + oldest = 105 does not fit → oldest is dropped too.
    const big = encodeSummary({ ...example, new: 9999, repeat: 9999, reminder: 9999, counts: { A: 9999, C: 9999, SLOT: 9999, RUN: 9999, F: 9999 }, slotStreak: 999 });
    expect(big).toBe("URG new=9999 rep=9999 rem=9999 | A=9999 C=9999 SLOT=9999(x999) RUN=9999 F=9999");
  });

  it("values above the display limits are clamped (`9999+`, `999+`), never truncating a field away", () => {
    const s = encodeSummary({ ...example, new: 1e9, counts: { A: 1e9, C: 1e9, SLOT: 1e9, RUN: 1e9, F: 1e9 }, slotStreak: 1e6, repeat: 1e9, reminder: 1e9 });
    expect(s).toBe("URG new=9999+ rep=9999+ rem=9999+ | A=9999+ C=9999+ SLOT=9999+(x999+) RUN=9999+ F=9999+");
    expect(bytes(s)).toBe(87);
  });

  it("B-U11 (property): 1,000 random inputs are always ≤ 100 UTF-8 bytes and printable ASCII, even with a non-ASCII run reference", () => {
    let seed = 42;
    const rnd = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % (max + 1);
    };
    const pick = () => [0, 1, 9, 10, 99, 999, 9999, 10000, 123456789][rnd(8)];
    for (let i = 0; i < 1000; i++) {
      const s = encodeSummary({
        new: pick(),
        repeat: pick(),
        reminder: pick(),
        counts: { A: pick(), C: pick(), SLOT: pick(), RUN: pick(), F: pick() },
        slotStreak: pick(),
        oldest: rnd(1) ? new Date(Date.UTC(2030 + rnd(5), rnd(11), 1 + rnd(27), rnd(23), rnd(59))) : null,
        runRef: rnd(1) ? "7f3a" : "é✓🥋ab",
      });
      expect(bytes(s)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
      expect(s).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("the M1 fault body is ≤ 100 bytes ASCII and codes only", () => {
    expect(encodeMonitorFault(["schedule=unsupported", "findings=unavailable"], "7f3a")).toBe("MON schedule=unsupported findings=unavailable | r=7f3a");
    expect(bytes(encodeMonitorFault(["D=" + "x".repeat(300)], "7f3a"))).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
  });
});

describe("planM2 (B-U12–B-U15)", () => {
  const now = t("2031-11-02T05:07:00Z");
  const row = (key: string, over: Partial<KeyRow> = {}): KeyRow => ({
    key,
    category: key.split(":")[0] as KeyRow["category"],
    source: "monitorRead",
    onsetNotBefore: null,
    evidenceAt: null,
    firstSeenAt: t("2031-11-02T05:00:00Z"),
    lastSeenAt: now,
    clearedAt: null,
    firstAcceptedAt: null,
    repeatAcceptedAt: null,
    lastMissedSlot: null,
    missedCount: 1,
    lastAttemptAt: null,
    lastErrorCode: null,
    ...over,
  });
  const accepted = (key: string, over: Partial<KeyRow> = {}) => row(key, { firstAcceptedAt: t("2031-11-02T04:52:00Z"), ...over });
  const done = (key: string, over: Partial<KeyRow> = {}) => accepted(key, { repeatAcceptedAt: t("2031-11-02T05:00:00Z"), ...over });

  it("B-U12: nothing unresolved → success; unresolved but nothing due → failRefresh; due with M2 Up → fail; otherwise → rearmFail", () => {
    expect(planM2({ rows: [], m2LastSignal: "fail", lastReminderAt: null, dbNow: now }).sequence).toBe("success");
    expect(planM2({ rows: [done("A:x:2031-11")], m2LastSignal: "fail", lastReminderAt: t("2031-11-02T05:00:00Z"), dbNow: now }).sequence).toBe("failRefresh");
    expect(planM2({ rows: [row("A:x:2031-11")], m2LastSignal: "success", lastReminderAt: null, dbNow: now }).sequence).toBe("fail");
    for (const signal of ["fail", "unknown"] as const) expect(planM2({ rows: [row("A:x:2031-11")], m2LastSignal: signal, lastReminderAt: null, dbNow: now }).sequence).toBe("rearmFail");
  });

  it("B-U13: repeat exactly once: accepted in an earlier run → repeat; repeat-accepted → never again", () => {
    const k = "RUNERR:org-x";
    expect(planM2({ rows: [row(k)], m2LastSignal: "unknown", lastReminderAt: null, dbNow: now })).toMatchObject({ newKeys: [k], repeatKeys: [] });
    expect(planM2({ rows: [accepted(k)], m2LastSignal: "fail", lastReminderAt: now, dbNow: now })).toMatchObject({ newKeys: [], repeatKeys: [k], due: true });
    expect(planM2({ rows: [done(k)], m2LastSignal: "fail", lastReminderAt: now, dbNow: now })).toMatchObject({ newKeys: [], repeatKeys: [], due: false });
  });

  it("B-U14: a reminder is due at ≥ 60 min since the last accepted /fail, not 1 ms earlier; nothing unresolved means no reminder", () => {
    const rows = [done("A:x:2031-11")];
    const at = (ms: number) => planM2({ rows, m2LastSignal: "fail", lastReminderAt: new Date(now.getTime() - ms), dbNow: now });
    expect(at(REMINDER_INTERVAL_MS - 1)).toMatchObject({ due: false, sequence: "failRefresh" });
    expect(at(REMINDER_INTERVAL_MS)).toMatchObject({ due: true, sequence: "rearmFail" });
    expect(at(REMINDER_INTERVAL_MS).summary).toMatchObject({ new: 0, repeat: 0, reminder: 1, counts: { A: 1 } });
    expect(planM2({ rows: [done("A:x:2031-11", { clearedAt: now })], m2LastSignal: "fail", lastReminderAt: null, dbNow: now }).due).toBe(false);
  });

  it("B-U15: several new problems → ONE sequence; the summary counts them all with every unresolved problem", () => {
    const p = planM2({
      rows: [
        row("A:a:2031-11", { onsetNotBefore: t("2031-11-01T21:00:00Z") }),
        row("C:c:noProgress"),
        row("SLOT:2031-11-02T00:00Z", { missedCount: 3 }),
        row("RUNERR:x"),
        accepted("RUNDET"),
        done("FAULT:findings"),
        done("A:old:2031-10", { clearedAt: now }),
      ],
      m2LastSignal: "success",
      lastReminderAt: now,
      dbNow: now,
    });
    expect(p.sequence).toBe("fail");
    expect(p.newKeys).toHaveLength(4);
    expect(p.repeatKeys).toEqual(["RUNDET"]);
    expect(p.summary).toMatchObject({ new: 4, repeat: 1, reminder: 1, counts: { A: 1, C: 1, SLOT: 1, RUN: 2, F: 1 }, slotStreak: 3, oldest: t("2031-11-01T21:00:00Z") });
  });
});
