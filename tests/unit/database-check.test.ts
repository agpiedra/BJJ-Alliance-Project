import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C1: `/api/health` is public and unauthenticated by design (an uptime monitor must be
 * able to hit it with no credentials), so a leaked URL polled aggressively — by a
 * misconfigured monitor, or on purpose — must never become a free way to load Postgres.
 * `checkDatabaseHealth` caches its result for a brief window; `check` is injectable so
 * this test never touches a real database, only the caching logic itself (a separate
 * integration test drives the route against a real one).
 */
const { checkDatabaseHealth, resetDatabaseHealthCacheForTests, CACHE_WINDOW_MS } = await import("../../src/lib/health/database-check");

beforeEach(() => {
  vi.useFakeTimers();
  resetDatabaseHealthCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkDatabaseHealth", () => {
  it("REQUIRED: a healthy check returns true", async () => {
    const check = vi.fn(async () => {});
    expect(await checkDatabaseHealth(check)).toBe(true);
  });

  it("REQUIRED: a throwing check returns false rather than rejecting", async () => {
    const check = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(checkDatabaseHealth(check)).resolves.toBe(false);
  });

  it("REQUIRED: a second call within the cache window does not check again — at most one real query per window", async () => {
    const check = vi.fn(async () => {});
    await checkDatabaseHealth(check);
    await checkDatabaseHealth(check);
    await checkDatabaseHealth(check);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED: a failed result is also cached — an outage doesn't turn into repeated real queries either", async () => {
    const check = vi.fn(async () => {
      throw new Error("down");
    });
    await checkDatabaseHealth(check);
    await checkDatabaseHealth(check);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED: after the cache window elapses, the next call checks again", async () => {
    const check = vi.fn(async () => {});
    await checkDatabaseHealth(check);
    vi.advanceTimersByTime(CACHE_WINDOW_MS + 1);
    await checkDatabaseHealth(check);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reflects a genuine recovery once the window elapses (not stuck on a stale failure forever)", async () => {
    const check = vi.fn<() => Promise<void>>(async () => {
      throw new Error("still down");
    });
    expect(await checkDatabaseHealth(check)).toBe(false);
    vi.advanceTimersByTime(CACHE_WINDOW_MS + 1);
    check.mockImplementation(async () => {});
    expect(await checkDatabaseHealth(check)).toBe(true);
  });
});
