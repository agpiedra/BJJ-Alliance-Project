import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { TenantContext, MembershipRole } from "../../src/lib/tenant/types";
import type { PromotionCandidate } from "../../src/lib/students/promotion-queue";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { adultRankId, type BeltCode } from "../helpers/belt-ranks";

const { listPromotionQueue, listApproachingStudents } = await import(
  "../../src/lib/students/promotion-queue"
);

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function ctx(role: MembershipRole, academyIds: string[] | "ALL", organizationId: string): TenantContext {
  return {
    kind: "tenant",
    actorUserId: "x",
    organizationId,
    organizationRole: role,
    academyIds,
    selfStudentId: null, linkedStudentId: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides: { currentBelt: BeltCode; currentStripes: number; beltAwardedAt: Date },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "PromotionQueueTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `promotion-queue-${suffix}@example.com`,
      currentRankId: adultRankId(overrides.currentBelt),
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`promotion-queue-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/**
 * Writes `count` synthetic CHECKIN rows with `classSessionId: null`, one per
 * day starting at `startAt`. `classSessionId: null` rows are manual-style
 * adjustments (see attendance-summary.ts's PROMOTION_RELEVANT comment) that
 * always count toward `atBeltCount` and, being unconstrained by any real
 * class schedule, let a test hit an exact attendance count without needing
 * `count` distinct real class occurrences to exist.
 */
async function addAttendances(
  studentId: string,
  academyId: string,
  organizationId: string,
  count: number,
  startAt: Date,
) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

function findCandidate(list: PromotionCandidate[], studentId: string) {
  return list.find((c) => c.studentId === studentId);
}

/**
 * Deterministically reproduces the TOCTOU race this file's promotion-queue
 * fix defends against: `classifyActiveStudents` runs one admin-wide
 * `prisma.student.findMany` scan, then — in a second step — looks up each
 * scanned student individually. A student that existed for the scan but is
 * gone by its own per-row lookup used to throw `P2025` and, because every
 * per-student lookup shared one `Promise.all`, sink every OTHER student's
 * classification in the same batch too.
 *
 * `appPrisma` (imported from `@/lib/prisma`) is the exact module-singleton
 * Prisma client `promotion-queue.ts` calls internally — not the separate
 * `PrismaClient` this file otherwise uses for fixture setup — so patching
 * its `student.findMany` here intercepts the real scan. The patched
 * implementation lets the real query run to completion (so the result still
 * contains `vanishingStudentId`, exactly as if the row still existed at scan
 * time), then hard-deletes that row before returning — guaranteeing the row
 * is gone by the time `classifyActiveStudents`'s per-student `Promise.all`
 * starts its own lookup for it, with no reliance on real concurrency or
 * timing.
 */
async function withStudentVanishingAfterScan<T>(vanishingStudentId: string, fn: () => Promise<T>): Promise<T> {
  const studentDelegate = appPrisma.student as unknown as {
    findMany: (...args: unknown[]) => Promise<unknown>;
  };
  const originalFindMany = studentDelegate.findMany.bind(studentDelegate);
  let alreadyDeleted = false;
  studentDelegate.findMany = async (...args: unknown[]) => {
    const result = await originalFindMany(...args);
    if (!alreadyDeleted) {
      alreadyDeleted = true;
      await prisma.student.delete({ where: { id: vanishingStudentId } });
    }
    return result;
  };
  try {
    return await fn();
  } finally {
    studentDelegate.findMany = originalFindMany;
  }
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i amendment 1: PromotionConfig
 * must be resolved ONCE per batch, not once per student. Patches the exact
 * `appPrisma` singleton `resolvePromotionConfigMap` calls internally (same
 * pattern as `withStudentVanishingAfterScan` above) and counts invocations.
 */
async function withPromotionConfigQueryCount<T>(fn: () => Promise<T>): Promise<{ result: T; queryCount: number }> {
  const delegate = appPrisma.promotionConfig as unknown as {
    findMany: (...args: unknown[]) => Promise<unknown>;
  };
  const original = delegate.findMany.bind(delegate);
  let queryCount = 0;
  delegate.findMany = async (...args: unknown[]) => {
    queryCount++;
    return original(...args);
  };
  try {
    const result = await fn();
    return { result, queryCount };
  } finally {
    delegate.findMany = original;
  }
}

describe("promotion queue", () => {
  afterAll(cleanup);

  it("a student exactly at a stripe threshold appears in listPromotionQueue as stripe-eligible", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // WHITE requires 30 attendancesPerStripe (global default) — exactly at
    // the threshold, not one short and not one over.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const candidate = findCandidate(queue, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("stripe-eligible");
    expect(candidate?.atBeltCount).toBe(30);
    expect(candidate?.remainingAttendance).toBe(0);
    expect(candidate?.currentBelt).toBe("WHITE");
    expect(candidate?.currentStripes).toBe(0);
    expect(candidate?.homeAcademyName).toBe(escazu.name);

    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student exactly at the exam threshold (4 stripes, attendancesForExam more) appears as exam-eligible", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-02-01T12:00:00Z");
    // beltAwardedAt marks when the BELT (not the 4th stripe) was awarded, so
    // atBeltCount accrues from there across all 4 stripes too —
    // computeBeltProgress's attendancesIntoCurrentStripeSpan subtracts
    // currentStripes * attendancesPerStripe (4 * 30 = 120) back out. Exactly
    // at the exam threshold means 120 (the 4 stripes) + 30 (WHITE's
    // attendancesForExam) = 150 total, matching attendance-summary.test.ts's
    // equivalent fixture and the schema's own comment on this field.
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 4, beltAwardedAt });

    await addAttendances(student.id, escazu.id, escazu.organizationId, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const candidate = findCandidate(queue, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("exam-eligible");
    expect(candidate?.atBeltCount).toBe(150);
    expect(candidate?.remainingAttendance).toBeNull();

    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student 3 attendances from a threshold appears ONLY in listApproachingStudents", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-03-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // 30 - 3 = 27: 3 attendances short of the next stripe.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const approaching = await listApproachingStudents(admin);
    const candidate = findCandidate(approaching, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("approaching");
    expect(candidate?.remainingAttendance).toBe(3);

    const queue = await listPromotionQueue(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
  });

  it("a student 20 attendances from any threshold appears in neither list", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-04-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // 30 - 20 = 10: 20 attendances short of the next stripe, beyond the
    // default 5-attendance "approaching" window.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 10, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a DIRECTOR/INSTRUCTOR session scoped to Escazú never sees an Escalante-only eligible student; ADMIN sees both", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const beltAwardedAt = new Date("2026-05-01T12:00:00Z");
    const escazuStudent = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    const escalanteStudent = await makeStudent(escalante.id, escalante.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
    });

    // Both exactly stripe-eligible.
    await Promise.all([
      addAttendances(escazuStudent.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS)),
      addAttendances(escalanteStudent.id, escalante.id, escalante.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS)),
    ]);

    const escazuInstructor = ctx("INSTRUCTOR", [escazu.id], escazu.organizationId);
    const scopedQueue = await listPromotionQueue(escazuInstructor);
    expect(findCandidate(scopedQueue, escazuStudent.id)).toBeDefined();
    expect(findCandidate(scopedQueue, escalanteStudent.id)).toBeUndefined();

    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const fullQueue = await listPromotionQueue(admin);
    expect(findCandidate(fullQueue, escazuStudent.id)).toBeDefined();
    expect(findCandidate(fullQueue, escalanteStudent.id)).toBeDefined();
  });

  it("a Black-belt student at any attendance count appears in neither list", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-06-01T12:00:00Z");
    // BLACK's global default requirement is 0/0/0 — maxStripes 0 means
    // currentStripes (0) already meets/exceeds it, and attendancesForExam 0
    // means computeBeltProgress never marks examEligible. classifyEligibility
    // should report "none" no matter how many attendances pile up.
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "BLACK", currentStripes: 0, beltAwardedAt });

    await addAttendances(student.id, escazu.id, escazu.organizationId, 500, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student hard-deleted between the admin-wide scan and its own per-row lookup is excluded from listPromotionQueue/listApproachingStudents without throwing, and without losing any OTHER student's result", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-07-01T12:00:00Z");

    // listPromotionQueue: a genuinely stripe-eligible survivor sharing the
    // same batch as a student that vanishes mid-scan.
    const survivor = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(survivor.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
    const vanishing = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    const queue = await withStudentVanishingAfterScan(vanishing.id, () => listPromotionQueue(admin));
    expect(findCandidate(queue, vanishing.id)).toBeUndefined();
    const survivorInQueue = findCandidate(queue, survivor.id);
    expect(survivorInQueue).toBeDefined();
    expect(survivorInQueue?.status).toBe("stripe-eligible");

    // listApproachingStudents: same race, a fresh vanishing student (the
    // first is already gone for real now, which wouldn't exercise the race
    // a second time) alongside a genuinely "approaching" survivor.
    const survivor2 = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(survivor2.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));
    const vanishing2 = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    const approaching = await withStudentVanishingAfterScan(vanishing2.id, () => listApproachingStudents(admin));
    expect(findCandidate(approaching, vanishing2.id)).toBeUndefined();
    const survivor2InApproaching = findCandidate(approaching, survivor2.id);
    expect(survivor2InApproaching).toBeDefined();
    expect(survivor2InApproaching?.status).toBe("approaching");
  });

  it("a PENDING student and an ARCHIVED student, both otherwise stripe/exam-eligible, are excluded from both lists while a genuinely ACTIVE student with equivalent attendance appears — proving the ACTIVE-only filter is real, not incidental", async () => {
    // Final whole-branch review finding N-1's entire justification for
    // `confirmPromotion`'s own server-side status guard leans on
    // `classifyActiveStudents`'s `status: "ACTIVE"` filter (this file's
    // `makeStudent` always seeds `status: "ACTIVE"` — every other test in
    // this file only ever proves the filter's absence would matter, never
    // that the filter itself is doing real work with a non-ACTIVE row
    // actually present in the data).
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-09-01T12:00:00Z");

    async function makeStudentWithStatus(status: "PENDING" | "ARCHIVED" | "ACTIVE") {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const student = await prisma.student.create({
        data: {
          homeAcademyId: escazu.id,
          organizationId: escazu.organizationId,
          firstName: "PromotionQueueStatusFilterTest",
          lastName: `Student-${status}-${suffix}`,
          phone: "88880000",
          email: `promotion-queue-status-${status}-${suffix}@example.com`.toLowerCase(),
          currentRankId: adultRankId("WHITE"),
          currentStripes: 0,
          beltAwardedAt,
          status,
          codeHash: digestLookupSecret(`promotion-queue-status-${status}-${suffix}`, pepper),
        },
      });
      cleanupStudentIds.push(student.id);
      return student;
    }

    // Stripe-eligible attendance (30) for a PENDING student and an ARCHIVED
    // student — both would appear in listPromotionQueue if the ACTIVE filter
    // weren't real.
    const pendingStudent = await makeStudentWithStatus("PENDING");
    await addAttendances(pendingStudent.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    const archivedStudent = await makeStudentWithStatus("ARCHIVED");
    await addAttendances(archivedStudent.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    // "Approaching" attendance (27, 3 short) for a second PENDING/ARCHIVED
    // pair — both would appear in listApproachingStudents if the ACTIVE
    // filter weren't real.
    const pendingApproaching = await makeStudentWithStatus("PENDING");
    await addAttendances(pendingApproaching.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const archivedApproaching = await makeStudentWithStatus("ARCHIVED");
    await addAttendances(archivedApproaching.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    // Genuinely ACTIVE controls with the exact same attendance shapes — must
    // appear, proving the absence of the PENDING/ARCHIVED rows above is
    // because of the status filter and not some other reason (e.g. an
    // unrelated query bug hiding every student).
    const activeStripeEligible = await makeStudentWithStatus("ACTIVE");
    await addAttendances(activeStripeEligible.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    const activeApproaching = await makeStudentWithStatus("ACTIVE");
    await addAttendances(activeApproaching.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    expect(findCandidate(queue, pendingStudent.id)).toBeUndefined();
    expect(findCandidate(queue, archivedStudent.id)).toBeUndefined();
    const activeCandidate = findCandidate(queue, activeStripeEligible.id);
    expect(activeCandidate).toBeDefined();
    expect(activeCandidate?.status).toBe("stripe-eligible");

    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(approaching, pendingApproaching.id)).toBeUndefined();
    expect(findCandidate(approaching, archivedApproaching.id)).toBeUndefined();
    const activeApproachingCandidate = findCandidate(approaching, activeApproaching.id);
    expect(activeApproachingCandidate).toBeDefined();
    expect(activeApproachingCandidate?.status).toBe("approaching");
  });

  it("resolves PromotionConfig ONCE per call, not once per student — proven by counting queries across a real multi-student batch", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const beltAwardedAt = new Date("2026-08-01T12:00:00Z");

    // 5 fresh students, deliberately varied so classifyActiveStudents
    // actually evaluates each one — on top of Alliance's own ~25 seeded
    // students already in this organization.
    const students = await Promise.all(
      Array.from({ length: 5 }, () =>
        makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt }),
      ),
    );
    await Promise.all(
      students.map((s, i) =>
        addAttendances(s.id, escazu.id, escazu.organizationId, 30 - i, new Date(beltAwardedAt.getTime() + DAY_MS)),
      ),
    );

    const { queryCount } = await withPromotionConfigQueryCount(() => listPromotionQueue(admin));
    expect(queryCount).toBe(1);
  });

  it("a TIME-mode student with no time anchor is excluded from the queue and logged with its student id, without sinking a valid sibling in the same batch", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const orgId = `promotion-queue-time-test-org-${suffix}`;
    const academyId = `promotion-queue-time-test-academy-${suffix}`;
    const rankId = `promotion-queue-time-test-rank-${suffix}`;

    await prisma.organization.create({ data: { id: orgId, slug: orgId, name: "Time Mode Test Org", status: "ACTIVE" } });
    await prisma.academy.create({
      data: { id: academyId, organizationId: orgId, name: "Time Mode Test Academy", slug: academyId, kioskTokenHash: `${academyId}-hash` },
    });
    await prisma.beltRank.create({
      data: {
        id: rankId,
        organizationId: orgId,
        track: "ADULT",
        code: "WHITE",
        labelEs: "Blanco",
        labelEn: "White",
        primaryColor: "#F0EBE0",
        barColor: "#111116",
        order: 1,
        maxStripes: 4,
        monthsPerStripe: 2,
        monthsForExam: 2,
        stripeColors: ["a", "b", "c", "d"],
      },
    });
    await prisma.promotionConfig.create({ data: { organizationId: orgId, track: "ADULT", mode: "TIME", requiresCoachApproval: true } });

    const missingAnchorStudent = await prisma.student.create({
      data: {
        homeAcademyId: academyId,
        organizationId: orgId,
        firstName: "TimeModeTest",
        lastName: `NoAnchor-${suffix}`,
        phone: "88880000",
        email: `time-mode-no-anchor-${suffix}@example.com`,
        currentRankId: rankId,
        currentStripes: 0,
        status: "ACTIVE",
        timeAnchorAt: null,
        codeHash: digestLookupSecret(`time-mode-no-anchor-${suffix}`, pepper),
      },
    });
    const validStudent = await prisma.student.create({
      data: {
        homeAcademyId: academyId,
        organizationId: orgId,
        firstName: "TimeModeTest",
        lastName: `WithAnchor-${suffix}`,
        phone: "88880000",
        email: `time-mode-with-anchor-${suffix}@example.com`,
        currentRankId: rankId,
        currentStripes: 0,
        status: "ACTIVE",
        // Well over 2 months (monthsPerStripe) before any plausible test-run date.
        timeAnchorAt: new Date("2026-01-01T00:00:00Z"),
        codeHash: digestLookupSecret(`time-mode-with-anchor-${suffix}`, pepper),
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const timeOrgAdmin = ctx("ADMIN", "ALL", orgId);
      const queue = await listPromotionQueue(timeOrgAdmin);

      expect(findCandidate(queue, missingAnchorStudent.id)).toBeUndefined();
      // The valid sibling in the SAME batch must still classify correctly —
      // proves one bad row doesn't sink the batch (2b's "strict engine,
      // caller decides handling").
      const validCandidate = findCandidate(queue, validStudent.id);
      expect(validCandidate).toBeDefined();
      expect(validCandidate?.status).toBe("stripe-eligible");

      // Not silently dropped: the skip is traceable to a cause (2c-i
      // amendment 2) — logged with the specific student id, not just a
      // generic message.
      const loggedWithStudentId = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes(missingAnchorStudent.id)),
      );
      expect(loggedWithStudentId).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await prisma.student.deleteMany({ where: { id: { in: [missingAnchorStudent.id, validStudent.id] } } });
      await prisma.promotionConfig.deleteMany({ where: { organizationId: orgId } });
      await prisma.beltRank.deleteMany({ where: { organizationId: orgId } });
      await prisma.academy.deleteMany({ where: { id: academyId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
  });
});
