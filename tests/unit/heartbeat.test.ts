import { describe, expect, it, vi } from "vitest";

/**
 * C1: a Healthchecks.io dead-man's switch. `pingHeartbeat(jobName, success, fetchImpl)`
 * hits the job's own configured URL — the plain URL for success, `<url>/fail` for a
 * failure — so a missed or failing run is visible even though nothing else in this app
 * calls Healthchecks. A job with no configured URL (nothing set up yet, per the runbook)
 * must never throw or silently pretend to have pinged: it reports "not_configured", which
 * `run-scheduled-job.ts` records on the JobRun row so the gap itself is visible.
 *
 * `fetchImpl` is injectable so this never makes a real network call.
 */
const { pingHeartbeat } = await import("../../src/lib/jobs/heartbeat");

// `vi.fn<typeof fetch>` declares the MOCK's type as fetch's own signature (so it's directly
// assignable to `pingHeartbeat`'s `fetchImpl` parameter, and `.mock.calls[0][0]` is typed),
// independent of the implementation's own (narrower) arity below.
function fakeFetch(status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

describe("pingHeartbeat", () => {
  const digestUrl = "https://hc-ping.com/digest-uuid";

  it("REQUIRED: a successful run pings the job's own configured URL, unmodified", async () => {
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
    const fetchImpl = fakeFetch();
    const outcome = await pingHeartbeat("weekly-digest", true, fetchImpl);
    expect(outcome).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(digestUrl);
    vi.unstubAllEnvs();
  });

  it("REQUIRED: a failed run pings <url>/fail — a different URL, not the same one with a flag", async () => {
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
    const fetchImpl = fakeFetch();
    const outcome = await pingHeartbeat("weekly-digest", false, fetchImpl);
    expect(outcome).toBe("ok");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${digestUrl}/fail`);
    vi.unstubAllEnvs();
  });

  it("REQUIRED: no configured URL is reported honestly, not silently treated as success", async () => {
    const fetchImpl = fakeFetch();
    const outcome = await pingHeartbeat("weekly-digest", true, fetchImpl);
    expect(outcome).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a non-2xx response from Healthchecks itself is a failed ping, not a thrown error", async () => {
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
    const outcome = await pingHeartbeat("weekly-digest", true, fakeFetch(500));
    expect(outcome).toBe("failed");
    vi.unstubAllEnvs();
  });

  it("REQUIRED: a hung request times out rather than blocking the job forever, and is reported as failed", async () => {
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
    vi.useFakeTimers();
    const hangs = vi.fn((_url: string, options?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const pending = pingHeartbeat("weekly-digest", true, hangs as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(outcome).toBe("failed");
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("a network error (fetch rejects) is a failed ping, never thrown to the caller", async () => {
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
    const throws = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await pingHeartbeat("weekly-digest", true, throws);
    expect(outcome).toBe("failed");
    vi.unstubAllEnvs();
  });

  describe("positive control: an unknown job name never resolves an env var by accident", () => {
    it("is not_configured even if an unrelated env var happens to be set", async () => {
      vi.stubEnv("HEALTHCHECK_DIGEST_URL", digestUrl);
      const fetchImpl = fakeFetch();
      // @ts-expect-error deliberately not a real JobName, to prove the mapping is exhaustive and closed
      const outcome = await pingHeartbeat("not-a-real-job", true, fetchImpl);
      expect(outcome).toBe("not_configured");
      expect(fetchImpl).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });
  });
});
