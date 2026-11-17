import type { M2Sequence, M2Signal } from "@/lib/monitoring/urgent/plan";

/**
 * The exact Healthchecks request sequences (design §7). Every dependency is injected (request, sleep, remaining time), so the
 * sequences are tested without a network or real waits.
 * - Accepted = HTTP 200 only. Anything else (timeout, network error, 4xx incl. 404 and 429, 5xx) is not accepted.
 * - One retry after RETRY_WAIT_MS, only after a timeout / network error or a 5xx, and only if at least
 *   MIN_REMAINING_FOR_RETRY_MS of the run's budget remains. Never after 429 (rate limited) or another 4xx.
 * - `success` is a GET of the check URL; `/fail` is a POST with the ≤ 100-byte body.
 * - At most 4 requests to M2 (rearmFail: success + retry + /fail + retry) and 2 to M1 per run. With one run at a time and
 *   ≥ 75 s between runs after a clean release and ≥ 125 s after a crash or failed release (the lease), no 60-second window
 *   holds more than 4 requests to one check (limit: 5 per minute). This assumes the platform kills a run at maxDuration (60 s).
 * - A `/fail` retry can never cause a second email: if the first `/fail` was in fact accepted, M2 is already Down and the
 *   retry makes no transition; if it was not, the retry makes the one transition.
 */
export const RETRY_WAIT_MS = 5_000;
export const MIN_REMAINING_FOR_RETRY_MS = 10_000;

export type PingKind = "success" | "fail";
export type PingResult = "accepted" | "notAccepted" | "rateLimited" | "notConfigured" | "notSent";

export interface SendDeps {
  /** One HTTP request; resolves to the status code, or null after a timeout or network error. Never throws. */
  request: (url: string, init: { method: "GET" | "POST"; body?: string }) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  remainingMs: () => number;
}

export interface PingOutcome {
  result: PingResult;
  requests: number;
}

export async function ping(url: string | undefined, kind: PingKind, body: string | undefined, deps: SendDeps, allowRetry = true): Promise<PingOutcome> {
  if (!url) return { result: "notConfigured", requests: 0 };
  const target = kind === "fail" ? `${url}/fail` : url;
  const init = kind === "fail" ? { method: "POST" as const, body: body ?? "" } : { method: "GET" as const };
  let requests = 0;
  for (;;) {
    const status = await deps.request(target, init);
    requests++;
    if (status === 200) return { result: "accepted", requests };
    if (status === 429) return { result: "rateLimited", requests };
    const retryable = status === null || status >= 500;
    if (!retryable || !allowRetry || requests >= 2 || deps.remainingMs() < MIN_REMAINING_FOR_RETRY_MS) return { result: "notAccepted", requests };
    await deps.sleep(RETRY_WAIT_MS);
  }
}

export interface M2Outcome {
  /** The new `m2LastSignal`; null when M2 is not configured (left unchanged). */
  signal: M2Signal | null;
  /** True only after HTTP 200 on a due `/fail` (`fail` or `rearmFail`): the counted problems may then be marked accepted. */
  failAccepted: boolean;
  result: PingResult;
  requests: number;
}

export async function executeM2(sequence: M2Sequence, url: string | undefined, body: string, deps: SendDeps): Promise<M2Outcome> {
  if (!url) return { signal: null, failAccepted: false, result: "notConfigured", requests: 0 };
  if (sequence === "none") return { signal: null, failAccepted: false, result: "notSent", requests: 0 };
  if (sequence === "success") {
    const s = await ping(url, "success", undefined, deps);
    return { signal: s.result === "accepted" ? "success" : "unknown", failAccepted: false, result: s.result, requests: s.requests };
  }
  if (sequence === "failRefresh") {
    // M2 is already Down: this only refreshes the body. No retry (no transition to make, no email depends on it).
    const f = await ping(url, "fail", body, deps, false);
    return { signal: f.result === "accepted" ? "fail" : "unknown", failAccepted: false, result: f.result, requests: f.requests };
  }
  let requests = 0;
  if (sequence === "rearmFail") {
    const s = await ping(url, "success", undefined, deps);
    requests += s.requests;
    if (s.result !== "accepted") return { signal: "unknown", failAccepted: false, result: s.result, requests };
  }
  const f = await ping(url, "fail", body, deps);
  requests += f.requests;
  return { signal: f.result === "accepted" ? "fail" : "unknown", failAccepted: f.result === "accepted", result: f.result, requests };
}
