import "dotenv/config";
import { describe, expect, it } from "vitest";

/**
 * C1: proves `/api/health` actually reaches a real Postgres database (the caching logic
 * itself is unit-tested in isolation, tests/unit/database-check.test.ts) — public, no
 * Authorization header, no secrets.
 */
const { resetDatabaseHealthCacheForTests } = await import("../../src/lib/health/database-check");
const { GET } = await import("../../src/app/api/health/route");

describe("GET /api/health", () => {
  it("REQUIRED: reports ok against the real test database, with no version or secret leaked", async () => {
    resetDatabaseHealthCacheForTests();
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });
});
