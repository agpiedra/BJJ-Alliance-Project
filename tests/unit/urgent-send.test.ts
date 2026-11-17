import { describe, expect, it, vi } from "vitest";
import { executeM2, ping, RETRY_WAIT_MS, MIN_REMAINING_FOR_RETRY_MS, type SendDeps } from "../../src/lib/monitoring/urgent/send";
import type { M2Sequence } from "../../src/lib/monitoring/urgent/plan";
import { LEASE_SECONDS, RUN_SPACING_SECONDS } from "../../src/lib/monitoring/urgent/store";
import { MONITOR_FUNCTION_MAX_SECONDS } from "../../src/lib/monitoring/urgent/run";

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

  it("none (review fix R4): no request, signal left unchanged, not counted as a failure", async () => {
    expect(await run("none", [200])).toEqual({ outcome: { signal: null, failAccepted: false, result: "notSent", requests: 0 }, calls: [] });
  });

  it("M2 not configured: no request, signal left unchanged (null)", async () => {
    const f = fake([]);
    expect(await executeM2("rearmFail", undefined, BODY, f.deps)).toEqual({ signal: null, failAccepted: false, result: "notConfigured", requests: 0 });
  });

  it("never more than 4 requests to M2 in any sequence and any failure pattern", async () => {
    const patterns: (number | null)[][] = [[null, null, null, null], [500, 500, 500, 500], [200, null, 500], [429], [404, 200], [null, 200, 429]];
    for (const sequence of ["success", "failRefresh", "fail", "rearmFail", "none"] as const) {
      for (const p of patterns) expect((await run(sequence, [...p])).calls.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("B-U20: the five-per-minute model (lease + spacing over 24 h of random deliveries, crashes and failed releases)", () => {
  /**
   * One run: up to 4 M2 requests at any time in [0, 60 s) (the platform kills a run at maxDuration = 60 s). Each run ends one
   * of three ways (review R2): a clean release (lastRunEndedAt = its end), a CRASH (killed at a random time; only the requests
   * before it happen; the lease is kept, lastRunEndedAt unchanged) or a FAILED RELEASE (all requests; lease kept).
   */
  const FUNCTION_MS = MONITOR_FUNCTION_MAX_SECONDS * 1000;
  type Ending = "clean" | "crash" | "releaseFailed";

  function simulate(spacingMs: number, leaseMs: number, seed: number, endings: Ending[] = ["clean", "crash", "releaseFailed"]) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Scheduled ticks every 15 min, each delivered 1–3 times (duplicates, catch-ups) within ±150 s: copies land on the
    // earliest takeover instant often enough to probe it.
    const deliveries: number[] = [];
    for (let tick = 0; tick < 24 * 4; tick++) {
      const copies = 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < copies; c++) deliveries.push(tick * 900_000 + Math.floor(rnd() * 300_000) - 150_000);
    }
    deliveries.sort((a, b) => a - b);
    let leaseUntil = -Infinity;
    let lastEnd = -Infinity;
    const m2: number[] = [];
    for (const start of deliveries) {
      if (start < leaseUntil || start <= lastEnd + spacingMs) continue; // the acquireLease predicate
      leaseUntil = start + leaseMs;
      const ending = endings[Math.floor(rnd() * endings.length)];
      const end = start + Math.floor(rnd() * FUNCTION_MS); // where it ends or is killed, < 60 s
      // Worst case for the window: the requests bunched just before the end.
      for (let i = 0; i < 4; i++) m2.push(Math.max(start, end - i * 1000));
      if (ending === "clean") {
        lastEnd = end;
        leaseUntil = -Infinity;
      }
    }
    return m2;
  }
  const maxInMinute = (times: number[]) => {
    const sorted = [...times].sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i < sorted.length; i++) max = Math.max(max, sorted.filter((x) => x >= sorted[i] && x < sorted[i] + 60_000).length);
    return max;
  };
  const lease = LEASE_SECONDS * 1000;
  const spacing = RUN_SPACING_SECONDS * 1000;

  it("lease ≥ function limit + 65 s: a crashed run's last request and the earliest takeover's first are > 60 s apart", () => {
    expect(lease).toBeGreaterThanOrEqual(FUNCTION_MS + 65_000);
    expect(spacing).toBeGreaterThan(60_000);
  });

  it("with the real rule (lease 125 s, spacing 75 s): never more than 4 requests to M2 in any 60-s window, with crashes and failed releases", () => {
    for (let seed = 1; seed <= 100; seed++) expect(maxInMinute(simulate(spacing, lease, seed))).toBeLessThanOrEqual(4);
  });

  it("earliest takeover after a crash at 59 s (deterministic): the next run starts at the lease end and stays within 4 per minute", () => {
    const crashed = [56_000, 57_000, 58_000, 59_000];
    const takeover = [0, 1_000, 2_000, 3_000].map((o) => lease + o);
    expect(maxInMinute([...crashed, ...takeover])).toBe(4);
  });

  it("positive control: the OLD 90 s lease with the same crash DOES put 8 requests in one minute (the test can fail)", () => {
    const crashed = [56_000, 57_000, 58_000, 59_000];
    const takeover = [0, 1_000, 2_000, 3_000].map((o) => 90_000 + o);
    expect(maxInMinute([...crashed, ...takeover])).toBe(8);
    const worst = Math.max(...Array.from({ length: 100 }, (_, i) => maxInMinute(simulate(spacing, 90_000, i + 1, ["crash"]))));
    expect(worst).toBeGreaterThan(4);
  });

  it("positive control: without the spacing rule clean runs DO exceed 5 per minute", () => {
    const worst = Math.max(...Array.from({ length: 50 }, (_, i) => maxInMinute(simulate(-Infinity, 0, i + 1, ["clean"]))));
    expect(worst).toBeGreaterThan(5);
  });
});
