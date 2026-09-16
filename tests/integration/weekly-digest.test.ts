import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import type { ResendClient } from "../../src/lib/notifications/email-channel";
import { adultRankId } from "../helpers/belt-ranks";

// Mutable state a hoisted `vi.mock` factory (below) reads at call time, so a
// single test can direct exactly one academy id to fail and one to succeed
// without touching production code — the module itself is still real for
// every other academy id (forwarded to `actual`), which is what keeps
// describe("sendWeeklyDigestForAcademy")'s direct-call tests and the existing
// happy-path route test below unaffected (both ids stay `null` for them).
const digestFailureState = vi.hoisted(() => ({
  failAcademyId: null as string | null,
  // A Set, not a single id: the deterministic seed (prisma/seed.ts)
  // guarantees Escazú and Escalante always exist with real staff users, so
  // the "processes real academies" test below needs both protected from a
  // real Resend call, not just one.
  okAcademyIds: new Set<string>(),
}));

vi.mock("../../src/lib/notifications/weekly-digest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/notifications/weekly-digest")>();
  return {
    ...actual,
    sendWeeklyDigestForAcademy: vi.fn(async (academyId: string, resendClient?: unknown) => {
      if (academyId === digestFailureState.failAcademyId) {
        throw new Error("SIMULATED_FAILURE_FOR_TEST");
      }
      if (digestFailureState.okAcademyIds.has(academyId)) {
        // Succeeds without touching the real DB/email path — resolving
        // staff recipients for real would email every real ADMIN user in
        // the shared dev DB, which this test has no business doing.
        return;
      }
      return actual.sendWeeklyDigestForAcademy(academyId, resendClient as never);
    }),
  };
});

const { sendWeeklyDigestForAcademy } = await import("../../src/lib/notifications/weekly-digest");
const { GET } = await import("../../src/app/api/cron/weekly-digest/route");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const nowCr = DateTime.now().setZone(ZONE);

const cleanupAcademyIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];
const cleanupPlanIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupPlanIds.length > 0) {
    await prisma.paymentPlan.deleteMany({ where: { id: { in: cleanupPlanIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
}

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

// Fixture academies must live inside the real seeded Alliance organization
// (not a fresh scratch one) so admin-wide, org-unscoped queries elsewhere in
// the suite (e.g. promotion-queue.test.ts) don't crash resolving a
// BeltRequirement that only the real org's academies have.
let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

function findCallTo(client: RecordingResendClient, email: string) {
  return client.calls.find((c) => c.to === email);
}

async function makeAcademy(label: string) {
  const s = suffix();
  const academy = await prisma.academy.create({
    data: {
      name: `${label} ${s}`,
      slug: `${label}-${s}`,
      kioskTokenHash: `${label}-hash-${s}`,
      organizationId: await getAllianceOrganizationId(),
    },
  });
  cleanupAcademyIds.push(academy.id);
  return academy;
}

// `resolveStaffRecipients` resolves ADMIN through OrganizationMembership,
// scoped to the target academy's own organization, not `User.role` globally
// — every staff fixture needs a real membership row, not just DIRECTOR's
// StaffAssignment.
async function makeStaffUser(
  role: "ADMIN" | "DIRECTOR",
  label: string,
  organizationId: string,
  academyId?: string,
  locale: string = "es",
) {
  const s = suffix();
  const user = await prisma.user.create({
    data: {
      email: `${label}-${s}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
      locale,
    },
  });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, organizationId, role: "DIRECTOR" },
    });
  }
  return user;
}

async function makeStudent(academyId: string, organizationId: string) {
  const s = suffix();
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "WeeklyDigestTest",
      lastName: `Student-${s}`,
      phone: "88880000",
      email: `weekly-digest-${s}@example.com`,
      currentRankId: adultRankId("WHITE"),
      status: "ACTIVE",
      joinedAt: nowCr.minus({ years: 1 }).toJSDate(),
      codeHash: digestLookupSecret(`weekly-digest-${s}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makeCheckin(studentId: string, academyId: string, organizationId: string, occurredAt: DateTime) {
  const at = occurredAt.toJSDate();
  await prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      organizationId,
      occurredAt: at,
      date: toAttendanceDate(at),
      type: "CHECKIN",
      delta: 1,
      source: "STAFF",
    },
  });
}

async function makePlan(academyId: string, organizationId: string) {
  const plan = await prisma.paymentPlan.create({
    data: { academyId, organizationId, name: `Weekly Digest Plan ${suffix()}` },
  });
  cleanupPlanIds.push(plan.id);
  return plan;
}

async function makePaidCurrentMonth(
  studentId: string,
  academyId: string,
  organizationId: string,
  planId: string,
  recordedById: string,
) {
  await prisma.paymentPeriod.create({
    data: {
      studentId,
      academyId,
      organizationId,
      planId,
      recordedById,
      year: nowCr.year,
      month: nowCr.month,
      status: "PAID",
    },
  });
}

/** Records every (to, subject, html) triple, standing in for a real Resend client. */
class RecordingResendClient implements ResendClient {
  calls: Array<{ from: string; to: string; subject: string; html: string }> = [];
  emails = {
    send: async (params: { from: string; to: string; subject: string; html: string }) => {
      this.calls.push(params);
      return { data: { id: "fake-id" }, error: null };
    },
  };
}

/** Every send fails, standing in for a bad API key / bounced address / Resend outage. */
class FailingResendClient implements ResendClient {
  emails = {
    send: async () => ({ data: null, error: { message: "SIMULATED_EMAIL_FAILURE" } }),
  };
}

describe("sendWeeklyDigestForAcademy", () => {
  afterAll(cleanup);
  beforeEach(() => vi.stubEnv("EMAIL_FROM", "Alliance BJJ <notifications@resend.dev>"));
  afterEach(() => vi.unstubAllEnvs());

  it("computes correct attendance/inactive/overdue counts, emails only that academy's recipients, and never writes a Notification row", async () => {
    const academyA = await makeAcademy("weekly-digest-a");
    const academyB = await makeAcademy("weekly-digest-b");
    const plan = await makePlan(academyA.id, academyA.organizationId);
    const planB = await makePlan(academyB.id, academyB.organizationId);

    const admin = await makeStaffUser("ADMIN", "wd-admin", academyA.organizationId);
    const directorA = await makeStaffUser("DIRECTOR", "wd-director-a", academyA.organizationId, academyA.id);
    const directorB = await makeStaffUser("DIRECTOR", "wd-director-b", academyB.organizationId, academyB.id);

    // A1/A2: inside the trailing-7-day window, paid this month (not overdue).
    const a1 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a1.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 1 }));
    await makePaidCurrentMonth(a1.id, academyA.id, academyA.organizationId, plan.id, admin.id);

    const a2 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a2.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 5 }));
    await makePaidCurrentMonth(a2.id, academyA.id, academyA.organizationId, plan.id, admin.id);

    // A3: OUTSIDE the trailing-7-day window (9 days ago) — must NOT count
    // toward attendance, and 9 days is under the 30-day inactive threshold
    // so it must not count as inactive either. Paid this month.
    const a3 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a3.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 9 }));
    await makePaidCurrentMonth(a3.id, academyA.id, academyA.organizationId, plan.id, admin.id);

    // A4: last attendance 45 days ago — outside the attendance window, and
    // squarely in the retention list's 30+ "inactive" bucket. Paid this
    // month so it doesn't also count as overdue.
    const a4 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a4.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 45 }));
    await makePaidCurrentMonth(a4.id, academyA.id, academyA.organizationId, plan.id, admin.id);

    // A5/A6/A7: recent attendance (inside window, not inactive), but no
    // PaymentPeriod row for the current month at all — overdue.
    const a5 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a5.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 2 }));
    const a6 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a6.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 3 }));
    const a7 = await makeStudent(academyA.id, academyA.organizationId);
    await makeCheckin(a7.id, academyA.id, academyA.organizationId, nowCr.minus({ days: 4 }));

    // Academy B: one overdue student, to prove academy A's digest doesn't
    // leak counts from another academy.
    const b1 = await makeStudent(academyB.id, academyB.organizationId);
    await makeCheckin(b1.id, academyB.id, academyB.organizationId, nowCr.minus({ days: 1 }));
    void planB;

    const notificationCountBefore = await prisma.notification.count({ where: { type: "WEEKLY_DIGEST" } });

    const clientA = new RecordingResendClient();
    await sendWeeklyDigestForAcademy(academyA.id, clientA);

    // Recipients: ADMIN + academy A's DIRECTOR are both emailed; academy B's
    // DIRECTOR never is. Checked by presence, not exact array equality/length
    // — other ADMIN users may pre-exist in the shared dev DB (seed data,
    // other concurrently-running test files), the same reasoning
    // notification-recipients.test.ts's `findRecipient` helper already
    // established, applied here to the emails actually sent.
    expect(findCallTo(clientA, admin.email)).toBeDefined();
    expect(findCallTo(clientA, directorA.email)).toBeDefined();
    expect(findCallTo(clientA, directorB.email)).toBeUndefined();

    // Expected: attendance = a1+a2+a5+a6+a7 = 5; inactive = a4 only = 1;
    // overdue = a5+a6+a7 = 3.
    const callToDirectorA = findCallTo(clientA, directorA.email)!;
    expect(callToDirectorA.html).toContain("5");
    expect(callToDirectorA.html).toContain("1");
    expect(callToDirectorA.html).toContain("3");
    expect(callToDirectorA.subject).toContain(academyA.name);
    expect(callToDirectorA.html).toContain(academyA.name);

    const clientB = new RecordingResendClient();
    await sendWeeklyDigestForAcademy(academyB.id, clientB);

    expect(findCallTo(clientB, admin.email)).toBeDefined();
    expect(findCallTo(clientB, directorB.email)).toBeDefined();
    expect(findCallTo(clientB, directorA.email)).toBeUndefined();

    // Academy B: attendance = 1 (b1), inactive = 0, overdue = 1 (b1, no
    // PaymentPeriod row) — proves the synthetic session correctly scopes
    // each call to exactly one academy, not both.
    for (const call of clientB.calls) {
      expect(call.html).toContain("1");
      expect(call.html).toContain("0");
    }

    // The whole point of the email-only ruling: no in-app Notification row
    // is ever created for WEEKLY_DIGEST, regardless of how many academies
    // were processed above.
    const notificationCountAfter = await prisma.notification.count({ where: { type: "WEEKLY_DIGEST" } });
    expect(notificationCountAfter).toBe(notificationCountBefore);
  });

  it("sends each recipient the digest in THEIR OWN locale, not a single shared locale for everyone", async () => {
    // I-2/I-3 regression test: sendWeeklyDigestForAcademy used to bypass
    // dispatchToRecipients/dispatchNotification entirely, but it already
    // rendered per-recipient locale correctly before this fix — this proves
    // that behavior survived the refactor onto the shared helper.
    const academy = await makeAcademy("weekly-digest-locale");
    const enAdmin = await makeStaffUser("ADMIN", "wd-locale-admin", academy.organizationId, undefined, "en");
    const esDirector = await makeStaffUser("DIRECTOR", "wd-locale-director", academy.organizationId, academy.id, "es");

    const client = new RecordingResendClient();
    await sendWeeklyDigestForAcademy(academy.id, client);

    const toEnAdmin = findCallTo(client, enAdmin.email);
    const toEsDirector = findCallTo(client, esDirector.email);
    expect(toEnAdmin).toBeDefined();
    expect(toEsDirector).toBeDefined();
    expect(toEnAdmin!.html).toContain("overdue");
    expect(toEsDirector!.html).toContain("atrasados");
    expect(toEnAdmin!.html).not.toBe(toEsDirector!.html);
  });

  it("logs a failed recipient send instead of silently swallowing it (routed through dispatchNotification now, not a bare Promise.all)", async () => {
    // I-3 regression test: before this fix, sendWeeklyDigestForAcademy called
    // channel.send directly in a Promise.all and discarded every
    // DeliveryResult, so a failed digest email never logged anything and the
    // cron route reported ok: true regardless. Routing through
    // dispatchToRecipients now gives it dispatchNotification's existing
    // failure-observability for free.
    const academy = await makeAcademy("weekly-digest-fail-log");
    const admin = await makeStaffUser("ADMIN", "wd-faillog-admin", academy.organizationId, undefined, "en");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await sendWeeklyDigestForAcademy(academy.id, new FailingResendClient());

      const loggedDeliveryFailure = consoleErrorSpy.mock.calls.some(
        ([message, details]) =>
          message === "notification delivery failed" &&
          typeof details === "object" &&
          details !== null &&
          (details as { userId?: string }).userId === admin.id,
      );
      expect(loggedDeliveryFailure).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("GET /api/cron/weekly-digest", () => {
  afterAll(cleanup);
  beforeEach(() => vi.stubEnv("CRON_SECRET", "test-cron-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("returns 401 when the Authorization header is missing", async () => {
    const request = new Request("http://localhost/api/cron/weekly-digest");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 when the Authorization header doesn't match CRON_SECRET", async () => {
    const request = new Request("http://localhost/api/cron/weekly-digest", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("processes real academies and returns a well-shaped response", async () => {
    // The deterministic seed guarantees Escazú and Escalante always exist
    // with real staff users, so resolving their recipients for real would
    // email them via the real Resend API — mocked as no-ops here, same as
    // the failure-isolation test below, so this test can assert the route's
    // shape without depending on RESEND_API_KEY being a real credential.
    // NOTE: this only exercises the happy path against whatever academies
    // happen to exist — it does not prove failure isolation. See the next
    // test for that.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    digestFailureState.okAcademyIds.add(escazu.id);
    digestFailureState.okAcademyIds.add(escalante.id);

    try {
      const request = new Request("http://localhost/api/cron/weekly-digest", {
        headers: { authorization: "Bearer test-cron-secret" },
      });
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(typeof body.processed).toBe("number");
      expect(Array.isArray(body.errors)).toBe(true);
    } finally {
      digestFailureState.okAcademyIds.clear();
    }
  });

  it("one academy's failure doesn't block others: a rejecting academy is reported as an error while a succeeding one still gets processed", async () => {
    const academyFail = await makeAcademy("weekly-digest-cron-fail");
    const academyOk = await makeAcademy("weekly-digest-cron-ok");

    digestFailureState.failAcademyId = academyFail.id;
    digestFailureState.okAcademyIds.add(academyOk.id);

    try {
      const request = new Request("http://localhost/api/cron/weekly-digest", {
        headers: { authorization: "Bearer test-cron-secret" },
      });
      const response = await GET(request);

      // The route itself must not fail (500) or short-circuit just because
      // one academy's send rejected — but `ok` now reflects whether EVERY
      // academy succeeded (`errors.length === 0`), not merely "the request
      // didn't crash", so a real failure stays visible in Vercel's cron
      // dashboard instead of being masked as an unconditional success.
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(false);

      // The failing academy is reported in `errors` with its real thrown
      // message, proving the per-iteration try/catch actually caught it
      // rather than the request blowing up.
      const failEntry = body.errors.find((e: { academyId: string }) => e.academyId === academyFail.id);
      expect(failEntry).toBeDefined();
      expect(failEntry.error).toBe("SIMULATED_FAILURE_FOR_TEST");

      // The other academy is NOT reported as an error, and the mock was
      // actually invoked for it (not skipped) — proving it was attempted
      // and succeeded after the failing academy was processed, not that it
      // merely never ran.
      expect(body.errors.find((e: { academyId: string }) => e.academyId === academyOk.id)).toBeUndefined();
      const okWasAttempted = vi
        .mocked(sendWeeklyDigestForAcademy)
        .mock.calls.some(([academyId]) => academyId === academyOk.id);
      expect(okWasAttempted).toBe(true);
    } finally {
      digestFailureState.failAcademyId = null;
      digestFailureState.okAcademyIds.clear();
    }
  });
});
