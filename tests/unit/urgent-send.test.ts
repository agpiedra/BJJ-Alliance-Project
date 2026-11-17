import { describe, expect, it, vi } from "vitest";
import { executeM2, ping, RETRY_WAIT_MS, MIN_REMAINING_FOR_RETRY_MS, type SendDeps } from "../../src/lib/monitoring/urgent/send";
import type { M2Sequence } from "../../src/lib/monitoring/urgent/plan";

/** PR-B B-U16–B-U20: exact request sequences, retries, rate limits, and the five-per-minute model. No network, no real waits. */
const M2 = "https://hc-ping.example/m2-uuid";
const BODY = "URG new=1 rep=0 rem=0 | A=1 C=0 SLOT=0 RUN=0 F=0 | r=7f3a";

/** A fake transport answering from a script; null = timeout / network error. Records every request with its virtual time. */
function fake(statuses: (number | null)[], remaining = 50_000) {
  let clock = 0;
  const calls: { url: string; method: string; body?: string; at: number }[] = [];
  const deps: SendDeps = {
    request: vi.fn(async (url, init) => {
      calls.push({ url, method: init.method, body: init.body, at: clock });
      clock += 5_000; // worst case: every request runs to its 5 s abort
      return statuses.length ? statuses.shift()! : 200;
    }),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    remainingMs: () => remaining - clock,
  };
  return { deps, calls };
}

describe("ping (B-U16, B-U18)", () => {
  it("success is a GET of the URL; /fail is a POST with the body; HTTP 200 only is accepted", async () => {
    const a = fake([200]);
    expect(await ping(M2, "success", undefined, a.deps)).toEqual({ result: "accepted", requests: 1 });
    expect(a.calls).toEqual([{ url: M2, method: "GET", body: undefined, at: 0 }]);
    const b = fake([200]);
    expect(await ping(M2, "fail", BODY, b.deps)).toEqual({ result: "accepted", requests: 1 });
    expect(b.calls[0]).toMatchObject({ url: `${M2}/fail`, method: "POST", body: BODY });
    for (const status of [201, 204, 302]) expect((await ping(M2, "success", undefined, fake([status]).deps)).result).toBe("notAccepted");
  });

  it("one retry after 5 s on a timeout / network error or a 5xx; never more than 2 requests", async () => {
    for (const first of [null, 500, 503]) {
      const f = fake([first, 200]);
      expect(await ping(M2, "fail", BODY, f.deps)).toEqual({ result: "accepted", requests: 2 });
      expect(f.deps.sleep).toHaveBeenCalledWith(RETRY_WAIT_MS);
    }
    const twice = fake([null, null, 200]);
    expect(await ping(M2, "fail", BODY, twice.deps)).toEqual({ result: "notAccepted", requests: 2 });
  });

  it("no retry after 429 (rate limited) or another 4xx such as 404 (misconfiguration)", async () => {
    expect(await ping(M2, "fail", BODY, fake([429, 200]).deps)).toEqual({ result: "rateLimited", requests: 1 });
    expect(await ping(M2, "fail", BODY, fake([404, 200]).deps)).toEqual({ result: "notAccepted", requests: 1 });
  });

  it("B-U18: the retry is skipped when less than 10 s of the budget remains", async () => {
    const f = fake([500, 200], MIN_REMAINING_FOR_RETRY_MS + 4_999); // after the first request (5 s) < 10 s remain
    expect(await ping(M2, "fail", BODY, f.deps)).toEqual({ result: "notAccepted", requests: 1 });
    expect(f.deps.sleep).not.toHaveBeenCalled();
  });

  it("not configured: no request at all", async () => {
    const f = fake([]);
    expect(await ping(undefined, "fail", BODY, f.deps)).toEqual({ result: "notConfigured", requests: 0 });
    expect(f.calls).toEqual([]);
  });
});

describe("executeM2: every sequence of design §7 (B-U16, B-U17)", () => {
  const run = async (sequence: M2Sequence, statuses: (number | null)[]) => {
    const f = fake(statuses);
    const outcome = await executeM2(sequence, M2, BODY, f.deps);
    return { outcome, calls: f.calls.map((c) => `${c.method} ${c.url.endsWith("/fail") ? "/fail" : "success"}`) };
  };

  it("worst case rearmFail: success, retry, /fail, retry = 4 requests sent at t = 0, 10, 15, 25 s; the /fail retry is accepted", async () => {
    const f = fake([500, 200, null, 200]);
    const outcome = await executeM2("rearmFail", M2, BODY, f.deps);
    expect(f.calls.map((c) => [c.method, c.at])).toEqual([
      ["GET", 0],
      ["GET", 10_000],
      ["POST", 15_000],
      ["POST", 25_000],
    ]);
    expect(outcome).toEqual({ signal: "fail", failAccepted: true, result: "accepted", requests: 4 });
  });

  it("B-U17: rearmFail whose success fails twice stops M2 after 2 requests: no /fail, not accepted, signal unknown", async () => {
    const { outcome, calls } = await run("rearmFail", [null, 500]);
    expect(calls).toEqual(["GET success", "GET success"]);
    expect(outcome).toEqual({ signal: "unknown", failAccepted: false, result: "notAccepted", requests: 2 });
  });

  it("fail: one /fail (+ one retry); failRefresh: one /fail, never retried, never counts as accepted content", async () => {
    expect(await run("fail", [200])).toEqual({ outcome: { signal: "fail", failAccepted: true, result: "accepted", requests: 1 }, calls: ["POST /fail"] });
    expect(await run("failRefresh", [500, 200])).toEqual({ outcome: { signal: "unknown", failAccepted: false, result: "notAccepted", requests: 1 }, calls: ["POST /fail"] });
    expect((await run("failRefresh", [200])).outcome).toEqual({ signal: "fail", failAccepted: false, result: "accepted", requests: 1 });
  });

  it("success: Up confirmed only on 200; a /fail timeout leaves the signal unknown (forces a re-arm next run)", async () => {
    expect((await run("success", [200])).outcome.signal).toBe("success");
    expect((await run("success", [null, null])).outcome.signal).toBe("unknown");
    expect((await run("fail", [null, null])).outcome).toMatchObject({ signal: "unknown", failAccepted: false });
  });

  it("M2 not configured: no request, signal left unchanged (null)", async () => {
    const f = fake([]);
    expect(await executeM2("rearmFail", undefined, BODY, f.deps)).toEqual({ signal: null, failAccepted: false, result: "notConfigured", requests: 0 });
  });

  it("never more than 4 requests to M2 in any sequence and any failure pattern", async () => {
    const patterns: (number | null)[][] = [[null, null, null, null], [500, 500, 500, 500], [200, null, 500], [429], [404, 200], [null, 200, 429]];
    for (const sequence of ["success", "failRefresh", "fail", "rearmFail"] as const) {
      for (const p of patterns) expect((await run(sequence, [...p])).calls.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("B-U20: the five-per-minute model (lease + 75 s spacing over 24 h of random deliveries)", () => {
  /** Request offsets of one run, worst case: M2 at p0+0/10/15/25 s with p0 = 5 s; the run ends at 52 s. */
  const M2_OFFSETS = [5, 15, 20, 30].map((s) => s * 1000);
  const RUN_MS = 52_000;

  function simulate(spacingMs: number, leaseMs: number, seed: number) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Scheduled ticks every 15 min, each delivered 1–3 times (duplicates, catch-ups) within ±90 s.
    const deliveries: number[] = [];
    for (let tick = 0; tick < 24 * 4; tick++) {
      const copies = 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < copies; c++) deliveries.push(tick * 900_000 + Math.floor(rnd() * 180_000) - 90_000);
    }
    deliveries.sort((a, b) => a - b);
    let leaseUntil = -Infinity;
    let lastEnd = -Infinity;
    const m2: number[] = [];
    for (const start of deliveries) {
      if (start < leaseUntil || start <= lastEnd + spacingMs) continue; // the acquireLease predicate
      leaseUntil = start + leaseMs;
      for (const o of M2_OFFSETS) m2.push(start + o);
      lastEnd = start + RUN_MS;
    }
    return m2;
  }
  const maxInMinute = (times: number[]) => {
    let max = 0;
    for (let i = 0; i < times.length; i++) max = Math.max(max, times.filter((x) => x >= times[i] && x < times[i] + 60_000).length);
    return max;
  };

  it("with the real rule (lease 90 s, spacing 75 s): never more than 4 requests to M2 in any 60-s window", () => {
    for (let seed = 1; seed <= 50; seed++) expect(maxInMinute(simulate(75_000, 90_000, seed))).toBeLessThanOrEqual(4);
  });

  it("positive control: without the spacing rule the same deliveries DO exceed 5 per minute (the test can fail)", () => {
    const worst = Math.max(...Array.from({ length: 50 }, (_, i) => maxInMinute(simulate(-Infinity, 0, i + 1))));
    expect(worst).toBeGreaterThan(5);
  });
});
