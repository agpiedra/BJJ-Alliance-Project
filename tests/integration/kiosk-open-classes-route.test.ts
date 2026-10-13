import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { nextBoundaryAfter } from "../../src/lib/scheduling/check-in-window";
import { cleanupClassFixtures, makeClassAcademy } from "../helpers/class-fixtures";

/**
 * The kiosk Entry screen's "open for check-in now" panel (Phase 2.6 PR 5) — the first caller of `openOccurrences`
 * that runs BEFORE any student is identified. This pins the NEW route's own wiring (academy/organization scoping,
 * the empty-vs-unavailable distinction, the token/org gates), not the underlying window math itself — that is
 * already proven exhaustively, including the midnight-crossing case, by kiosk-window-rules.test.ts.
 */
const { POST: openClassesRoute } = await import("../../src/app/api/kiosk/open-classes/route");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

afterEach(() => vi.useRealTimers());
afterAll(async () => cleanupClassFixtures());

/** Costa Rica Monday 2026-01-05 h:m (UTC-6; hours past 23 roll into Tuesday). */
const mon = (h: number, m: number) => new Date(Date.UTC(2026, 0, 5, h + 6, m));

async function call(now: Date, academySlug: string, token: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const response = await openClassesRoute(
    new Request("http://localhost/api/kiosk/open-classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ academySlug, token }),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function fixture() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A", type: "GI" },
    { dayOfWeek: "MONDAY", startTime: "22:00", durationMinutes: 120, name: "C", type: "OPEN_MAT" },
    { dayOfWeek: "TUESDAY", startTime: "00:10", durationMinutes: 60, name: "D", type: "KIDS" },
  ]);
  const token = `open-classes-token-${academy.id}`;
  await prisma.academy.update({ where: { id: academy.id }, data: { kioskTokenHash: digestLookupSecret(token, pepper) } });
  return { academy, sessions, token };
}

describe("the open-classes read is scoped to exactly this academy's active sessions", () => {
  it("another academy's class, and an inactive class at THIS academy, never appear", async () => {
    const f = await fixture();
    const other = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "Other-A", type: "GI" }]);
    const inactive = await prisma.classSession.create({
      data: { academyId: f.academy.id, organizationId: f.academy.organizationId, dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "Inactive-A", type: "GI", active: false },
    });

    const { status, json } = await call(mon(18, 0), f.academy.slug, f.token);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const names = (json.openClasses as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["A"]);
    expect(names).not.toContain("Other-A");
    expect(names).not.toContain(inactive.name);
  });

  it("midnight crossing: at Monday 23:50, C (22:00-00:00, open until 00:30) and D (Tuesday 00:10, open from 23:40) are BOTH reported open, matching the same window kiosk-window-rules.test.ts proves for check-in", async () => {
    const f = await fixture();
    const { status, json } = await call(mon(23, 50), f.academy.slug, f.token);
    expect(status).toBe(200);
    const names = (json.openClasses as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["C", "D"]);
  });
});

describe("empty vs unavailable are distinct outcomes", () => {
  it("no class open right now: a successful 200 with an empty array, not an error", async () => {
    const f = await fixture();
    const { status, json } = await call(mon(15, 0), f.academy.slug, f.token);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.openClasses).toEqual([]);
    expect(typeof json.refreshAt).toBe("string");
  });

  it("refreshAt is nextBoundaryAfter over the SAME sessions and the SAME now the route already used — never re-derived here", async () => {
    const f = await fixture();
    const now = mon(15, 0);
    const { status, json } = await call(now, f.academy.slug, f.token);
    expect(status).toBe(200);
    const expected = nextBoundaryAfter(f.sessions, now);
    expect(json.refreshAt).toBe(expected.toISOString());
  });

  it("an unknown academy slug: the same indistinguishable invalid_token shape as the other kiosk routes", async () => {
    const { status, json } = await call(mon(18, 0), "no-such-academy-slug", "whatever");
    expect(status).toBe(404);
    expect(json).toEqual({ ok: false, error: "invalid_token" });
  });

  it("a wrong token for a real academy: invalid_token, same shape as an unknown slug", async () => {
    const f = await fixture();
    const { status, json } = await call(mon(18, 0), f.academy.slug, "wrong-token");
    expect(status).toBe(401);
    expect(json).toEqual({ ok: false, error: "invalid_token" });
  });

  it("an organization that is not ACTIVE: org_unavailable, never a false empty list", async () => {
    const f = await fixture();
    await prisma.organization.update({ where: { id: f.academy.organizationId }, data: { status: "SUSPENDED" } });
    const { status, json } = await call(mon(18, 0), f.academy.slug, f.token);
    expect(status).toBe(403);
    expect(json).toEqual({ ok: false, error: "org_unavailable" });
    await prisma.organization.update({ where: { id: f.academy.organizationId }, data: { status: "ACTIVE" } });
  });
});
