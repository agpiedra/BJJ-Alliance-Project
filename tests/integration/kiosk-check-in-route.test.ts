import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DayOfWeek } from "../../src/generated/prisma/client";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { ZONE } from "../../src/lib/scheduling/zone";

// I-1 regression coverage: notifyEligibilityReached must still fire when a
// check-in that crosses the stripe threshold comes in through this REAL
// route entry point (not just via a direct performCheckIn call) — this is
// the seam Fix 1 (after()-wrapped fire-and-forget) touches. Mocked rather
// than left real so this file doesn't depend on/pollute real staff
// Notification rows or a real Resend call.
const notifyEligibilityState = vi.hoisted(() => ({ spy: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("../../src/lib/notifications/notify-eligibility", () => ({
  notifyEligibilityReached: (...args: unknown[]) => notifyEligibilityState.spy(...args),
}));

/**
 * Route-handler-level coverage for `POST /api/kiosk/check-in`.
 *
 * This file exists because that handler is the seam the Critical "the atomic
 * rate-limit gate runs AFTER the guess is evaluated" bug lived in, was fixed
 * in, and was corrected again in — and it had no automated coverage at all.
 * The load-bearing assertion here is not the status code: it is that a locked
 * out kiosk writes ZERO `AttendanceRecord` rows even when handed a genuinely
 * VALID code, which is the only thing that actually proves the gate runs in
 * front of `performCheckIn` rather than behind it.
 *
 * The handler is imported and called directly with a plain `Request`. That is
 * possible only because it reads `x-forwarded-for` off the `Request` argument
 * rather than `next/headers`' `headers()`, which throws outside a real request
 * scope (verified empirically against this exact handler).
 */
const { POST } = await import("../../src/app/api/kiosk/check-in/route");

const prisma = getTestPrismaClient();

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}
const pepper = requireEnv("CODE_PEPPER");

const cleanupAcademyIds: string[] = [];
const cleanupStudentIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

/**
 * A CR-local weekday + "HH:mm" for the moment the suite starts, so a fixture
 * session's ±30-minute window contains real server `now` — the handler uses
 * the real clock (there is no `now` override on the HTTP surface, only the
 * bounded `queuedAt` replay field).
 */
let todaysDayOfWeek: DayOfWeek;
let nowStartTime: string;

const DAY_NAMES: DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

beforeAll(() => {
  const nowCr = DateTime.now().setZone(ZONE);
  todaysDayOfWeek = DAY_NAMES[nowCr.weekday - 1];
  nowStartTime = nowCr.toFormat("HH:mm");
});

afterAll(async () => {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.kioskAttempt.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
    await prisma.classSession.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
  if (cleanupOrganizationIds.length > 0) {
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: cleanupOrganizationIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: cleanupOrganizationIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds } } });
  }
});

/**
 * A private academy with a real kiosk token and one class whose window is open
 * right now. Private rather than the seeded Escazú academy because
 * `seed.test.ts` / `session-scoping.test.ts` assert Escazú's exact session
 * count and vitest runs test files in parallel.
 */
async function makeFixture() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const token = `kiosk-route-token-${suffix}`;
  const kioskTokenHash = digestLookupSecret(token, pepper);

  const academy = await prisma.academy.create({
    data: {
      name: `Kiosk Route Fixture ${suffix}`,
      slug: `kiosk-route-${suffix}`,
      kioskTokenHash,
      organizationId: await getAllianceOrganizationId(),
    },
  });
  cleanupAcademyIds.push(academy.id);

  await prisma.classSession.create({
    data: {
      academyId: academy.id,
      organizationId: academy.organizationId,
      dayOfWeek: todaysDayOfWeek,
      startTime: nowStartTime,
      durationMinutes: 60,
      name: "Open Now",
      type: "GI",
      countsTowardPromotion: true,
    },
  });

  return { academy, token, kioskTokenHash };
}

/**
 * A private organization + academy + open class, with its own kiosk token —
 * used only by the suspended-organization tests below, which need to control
 * the organization's `status` directly (the shared Alliance org is always
 * ACTIVE and other test files depend on that).
 */
async function makeOrgFixture(status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED") {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const organization = await prisma.organization.create({
    data: { slug: `kiosk-org-${suffix}`, name: `Kiosk Org Fixture ${suffix}`, status },
  });
  cleanupOrganizationIds.push(organization.id);

  const token = `kiosk-org-token-${suffix}`;
  const kioskTokenHash = digestLookupSecret(token, pepper);
  const academy = await prisma.academy.create({
    data: {
      name: `Kiosk Org Academy ${suffix}`,
      slug: `kiosk-org-academy-${suffix}`,
      kioskTokenHash,
      organizationId: organization.id,
    },
  });
  cleanupAcademyIds.push(academy.id);

  await prisma.classSession.create({
    data: {
      academyId: academy.id,
      organizationId: organization.id,
      dayOfWeek: todaysDayOfWeek,
      startTime: nowStartTime,
      durationMinutes: 60,
      name: "Open Now",
      type: "GI",
      countsTowardPromotion: true,
    },
  });

  // A brand-new organization has no BeltRank rows at all — Student.currentRankId
  // is a required FK, so `makeStudent` below find-or-creates the WHITE rank
  // it needs for whatever organizationId it's given.

  return { organization, academy, token };
}

/**
 * Alliance (the shared org via makeFixture) already has the seeded WHITE
 * rank at `adultRankId("WHITE")`; a scratch org from makeOrgFixture has
 * none yet — this resolves either case uniformly with a find-or-create.
 */
async function resolveWhiteRankId(organizationId: string): Promise<string> {
  const existing = await prisma.beltRank.findUnique({
    where: { organizationId_track_code: { organizationId, track: "ADULT", code: "WHITE" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.beltRank.create({
    data: {
      organizationId,
      track: "ADULT",
      code: "WHITE",
      labelEs: "Blanco",
      labelEn: "White",
      primaryColor: "#F0EBE0",
      barColor: "#111116",
      order: 0,
      maxStripes: 4,
      attendancesPerStripe: 30,
      attendancesForExam: 120,
      stripeColors: ["#000000", "#000000", "#000000", "#000000"],
      visibleStripeSlots: 4,
    },
  });
  // getAtBeltSummary (MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i) requires a
  // real PromotionConfig row for this organization/track — a scratch org's
  // BeltRank alone isn't enough anymore, unlike before the engine migration.
  await prisma.promotionConfig.upsert({
    where: { organizationId_track: { organizationId, track: "ADULT" } },
    update: {},
    create: { organizationId, track: "ADULT", mode: "ATTENDANCE", requiresCoachApproval: true },
  });
  return created.id;
}

async function makeStudent(homeAcademyId: string, organizationId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const code = `kiosk-route-code-${suffix}`;
  const currentRankId = await resolveWhiteRankId(organizationId);
  const student = await prisma.student.create({
    data: {
      homeAcademyId,
      organizationId,
      firstName: "KioskRouteTest",
      lastName: "Student",
      phone: "88882222",
      email: `kiosk-route-${suffix}@example.com`,
      currentRankId,
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-01T00:00:00Z"),
      status: "ACTIVE",
      codeHash: digestLookupSecret(code, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return { student, code };
}

/** Writes `count` real CHECKIN rows (no classSessionId), one per day starting at `startAt`. */
async function addSyntheticCheckins(
  studentId: string,
  academyId: string,
  organizationId: string,
  count: number,
  startAt: Date,
) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

async function post(body: unknown) {
  const request = new Request("http://localhost/api/kiosk/check-in", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("POST /api/kiosk/check-in", () => {
  afterEach(() => notifyEligibilityState.spy.mockClear());

  it("I-1: fires notifyEligibilityReached through the REAL route entry point when a check-in crosses the stripe threshold", async () => {
    const { academy, token } = await makeFixture();
    const { student, code } = await makeStudent(academy.id, academy.organizationId);

    // WHITE belt requires 30 attendances/stripe (same fixture math as
    // perform-check-in.test.ts) — 29 synthetic + this route's real check-in
    // crosses the threshold. Must be on/after makeStudent's beltAwardedAt
    // (2026-01-01) — getAtBeltSummary only counts attendance from then on.
    await addSyntheticCheckins(student.id, academy.id, academy.organizationId, 29, new Date("2026-01-02T12:00:00Z"));

    const { status, json } = await post({ academySlug: academy.slug, token, code });

    expect(status).toBe(200);
    expect(json.earnedStripe).toBe(true);
    expect(notifyEligibilityState.spy).toHaveBeenCalledWith(student.id, "STRIPE_THRESHOLD");
  });

  it("checks a student in and returns the documented 200 shape", async () => {
    const { academy, token } = await makeFixture();
    const { student, code } = await makeStudent(academy.id, academy.organizationId);

    const { status, json } = await post({ academySlug: academy.slug, token, code });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      student: { firstName: "KioskRouteTest", lastName: "Student", currentBelt: "WHITE", currentStripes: 0 },
      isVisitor: false,
      homeAcademyName: academy.name,
      earnedStripe: false,
    });
    expect((json.summary as Record<string, unknown>).atBeltCount).toBe(1);

    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1);

    // The reserved attempt was upgraded to a success and dropped out of the
    // lockout anchor.
    const attempt = await prisma.kioskAttempt.findFirstOrThrow({ where: { academyId: academy.id } });
    expect(attempt.success).toBe(true);
    expect(attempt.countsAsFailure).toBe(false);
    expect(attempt.ipAddress).toBe("203.0.113.7");
  });

  it("REJECTS a VALID code with 429 while locked out, and writes NO AttendanceRecord", async () => {
    const { academy, token, kioskTokenHash } = await makeFixture();
    const { student, code } = await makeStudent(academy.id, academy.organizationId);

    // Five genuine wrong-code guesses inside the trailing 60s window, exactly
    // as `finalizeKioskAttempt("invalid_code")` records them.
    await prisma.kioskAttempt.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        academyId: academy.id,
        organizationId: academy.organizationId,
        kioskTokenHash,
        ipAddress: "203.0.113.7",
        success: false,
        countsAsFailure: true,
        createdAt: new Date(Date.now() - (5 - i) * 1000),
      })),
    });

    const { status, json } = await post({ academySlug: academy.slug, token, code });

    expect(status).toBe(429);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("locked_out");
    expect(typeof json.retryAfterSeconds).toBe("number");

    // THE assertion this file exists for: the code was never evaluated at all.
    // A 429 whose payload merely *looks* right would still be a bypass if
    // `performCheckIn` had already run and committed the check-in behind it.
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);

    // The refused request is still logged (spec §4.1) but excluded from the
    // anchor, so hammering a lockout can't renew it.
    const rejected = await prisma.kioskAttempt.findFirstOrThrow({
      where: { academyId: academy.id },
      orderBy: { createdAt: "desc" },
    });
    expect(rejected.success).toBe(false);
    expect(rejected.countsAsFailure).toBe(false);
  });

  it("records a wrong code as a COUNTING failure and a valid-code failure as a non-counting one", async () => {
    const { academy, token } = await makeFixture();
    const { code } = await makeStudent(academy.id, academy.organizationId);

    const wrong = await post({ academySlug: academy.slug, token, code: "definitely-not-a-real-code" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_code");
    const wrongAttempt = await prisma.kioskAttempt.findFirstOrThrow({
      where: { academyId: academy.id },
      orderBy: { createdAt: "desc" },
    });
    expect(wrongAttempt.countsAsFailure).toBe(true);

    // First tap succeeds; the second is `already_checked_in` — a VALID code,
    // so it must not feed the brute-force counter.
    expect((await post({ academySlug: academy.slug, token, code })).status).toBe(200);
    const repeat = await post({ academySlug: academy.slug, token, code });
    expect(repeat.status).toBe(400);
    expect(repeat.json.error).toBe("already_checked_in");
    const repeatAttempt = await prisma.kioskAttempt.findFirstOrThrow({
      where: { academyId: academy.id },
      orderBy: { createdAt: "desc" },
    });
    expect(repeatAttempt.success).toBe(false);
    expect(repeatAttempt.countsAsFailure).toBe(false);
  });

  it("does not lock the whole kiosk out after five double-taps by one student", async () => {
    const { academy, token } = await makeFixture();
    const { code } = await makeStudent(academy.id, academy.organizationId);
    const other = await makeStudent(academy.id, academy.organizationId);

    expect((await post({ academySlug: academy.slug, token, code })).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const repeat = await post({ academySlug: academy.slug, token, code });
      expect(repeat.status).toBe(400);
      expect(repeat.json.error).toBe("already_checked_in");
    }

    // The next student on the same shared tablet must still get in.
    const next = await post({ academySlug: academy.slug, token, code: other.code });
    expect(next.status).toBe(200);
    expect(await prisma.attendanceRecord.count({ where: { studentId: other.student.id } })).toBe(1);
  });

  it("returns 401 for a bad token and 404 for an unknown slug, in the same generic shape", async () => {
    const { academy } = await makeFixture();

    const badToken = await post({ academySlug: academy.slug, token: "not-the-real-token", code: "whatever" });
    expect(badToken.status).toBe(401);
    expect(badToken.json).toEqual({ ok: false, error: "invalid_token" });

    const unknownSlug = await post({ academySlug: `no-such-academy-${Date.now()}`, token: "x", code: "y" });
    expect(unknownSlug.status).toBe(404);
    expect(unknownSlug.json).toEqual({ ok: false, error: "invalid_token" });

    // A request that never got past token verification never reaches the
    // limiter, so it leaves no attempt row to skew anyone's window.
    expect(await prisma.kioskAttempt.count({ where: { academyId: academy.id } })).toBe(0);
  });

  it("rejects a check-in against a PENDING/SUSPENDED/CANCELLED organization with a generic 403, before any student-code resolution", async () => {
    for (const status of ["PENDING", "SUSPENDED", "CANCELLED"] as const) {
      const { organization, academy, token } = await makeOrgFixture(status);
      const { code } = await makeStudent(academy.id, organization.id);

      // A genuinely valid code and a garbage one must produce the EXACT same
      // response — the message must not disclose whether a submitted code
      // was valid, per spec.
      const validCode = await post({ academySlug: academy.slug, token, code });
      const garbageCode = await post({ academySlug: academy.slug, token, code: "not-a-real-code" });

      expect(validCode.status).toBe(403);
      expect(validCode.json).toEqual({ ok: false, error: "org_unavailable" });
      expect(garbageCode.status).toBe(403);
      expect(garbageCode.json).toEqual({ ok: false, error: "org_unavailable" });

      // Rejected before student-code resolution: no attendance was ever
      // written, even for the genuinely valid code.
      expect(await prisma.attendanceRecord.count({ where: { academyId: academy.id } })).toBe(0);

      // Rejected before the rate-limit gate too: no KioskAttempt row exists
      // for either request, matching the existing bad-token/unknown-slug
      // behavior (a request that never gets past this checkpoint leaves no
      // attempt row to skew anyone's window).
      expect(await prisma.kioskAttempt.count({ where: { academyId: academy.id } })).toBe(0);
    }
  });

  it("reactivating a SUSPENDED organization restores check-in with the SAME unrotated kiosk token, and prior attendance is unchanged", async () => {
    const { organization, academy, token } = await makeOrgFixture("SUSPENDED");
    const { student, code } = await makeStudent(academy.id, organization.id);

    const rejected = await post({ academySlug: academy.slug, token, code });
    expect(rejected.status).toBe(403);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);

    await prisma.organization.update({ where: { id: organization.id }, data: { status: "ACTIVE" } });

    // Same academySlug, same never-rotated token.
    const { status, json } = await post({ academySlug: academy.slug, token, code });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1);
  });

  it("does not cross-match: two organizations' students may share the identical PIN, and each kiosk only checks in its own", async () => {
    const orgA = await makeOrgFixture("ACTIVE");
    const orgB = await makeOrgFixture("ACTIVE");
    const sharedCode = "7391"; // identical plaintext PIN in both organizations

    const studentA = await prisma.student.create({
      data: {
        homeAcademyId: orgA.academy.id,
        organizationId: orgA.organization.id,
        firstName: "SharedPin",
        lastName: "OrgA",
        phone: "88883333",
        email: `kiosk-shared-pin-a-${Date.now()}@example.com`,
        currentRankId: await resolveWhiteRankId(orgA.organization.id),
        currentStripes: 0,
        status: "ACTIVE",
        codeHash: digestLookupSecret(sharedCode, pepper),
      },
    });
    cleanupStudentIds.push(studentA.id);

    const studentB = await prisma.student.create({
      data: {
        homeAcademyId: orgB.academy.id,
        organizationId: orgB.organization.id,
        firstName: "SharedPin",
        lastName: "OrgB",
        phone: "88884444",
        email: `kiosk-shared-pin-b-${Date.now()}@example.com`,
        currentRankId: await resolveWhiteRankId(orgB.organization.id),
        currentStripes: 0,
        status: "ACTIVE",
        codeHash: digestLookupSecret(sharedCode, pepper),
      },
    });
    cleanupStudentIds.push(studentB.id);

    const resultA = await post({ academySlug: orgA.academy.slug, token: orgA.token, code: sharedCode });
    expect(resultA.status).toBe(200);
    expect((resultA.json.student as Record<string, unknown>).lastName).toBe("OrgA");

    const resultB = await post({ academySlug: orgB.academy.slug, token: orgB.token, code: sharedCode });
    expect(resultB.status).toBe(200);
    expect((resultB.json.student as Record<string, unknown>).lastName).toBe("OrgB");

    // Each check-in landed on the right student in the right organization —
    // no cross-matching between the two identical PINs.
    expect(await prisma.attendanceRecord.count({ where: { studentId: studentA.id } })).toBe(1);
    expect(await prisma.attendanceRecord.count({ where: { studentId: studentB.id } })).toBe(1);
    expect(
      await prisma.attendanceRecord.findFirst({ where: { studentId: studentA.id, organizationId: orgB.organization.id } }),
    ).toBeNull();
  });

  it("returns 400 invalid_request for a malformed body", async () => {
    const { academy, token } = await makeFixture();

    const missingCode = await post({ academySlug: academy.slug, token });
    expect(missingCode.status).toBe(400);
    expect(missingCode.json).toEqual({ ok: false, error: "invalid_request" });

    const notJson = await POST(
      new Request("http://localhost/api/kiosk/check-in", { method: "POST", body: "{not json" }),
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ ok: false, error: "invalid_request" });
  });
});
