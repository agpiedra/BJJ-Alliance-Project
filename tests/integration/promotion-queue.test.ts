import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import type { Belt } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { StaffSession } from "../../src/lib/auth/session";
import type { PromotionCandidate } from "../../src/lib/students/promotion-queue";
import { prisma as appPrisma } from "../../src/lib/prisma";

const { listPromotionQueue, listApproachingStudents } = await import(
  "../../src/lib/students/promotion-queue"
);

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

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
  overrides: { currentBelt: Belt; currentStripes: number; beltAwardedAt: Date },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "PromotionQueueTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `promotion-queue-${suffix}@example.com`,
      currentBelt: overrides.currentBelt,
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
async function addAttendances(studentId: string, academyId: string, count: number, startAt: Date) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
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
 * Simulates a genuinely missing global `BeltRequirement` row for `belt` —
 * the round-2 regression case. Unlike `withStudentVanishingAfterScan` above
 * (a benign, gracefully-excludable race), this must propagate loudly: it's
 * a seed-data/configuration bug, not a race, and this codebase's fix must
 * NOT conflate the two.
 *
 * Patches `appPrisma.beltRequirement.findFirstOrThrow` (the exact call
 * `resolveBeltRequirementLike`/`resolveBeltRequirement` make internally for
 * the academy-null global-default fallback) to throw a Prisma-P2025-shaped
 * error, but ONLY when called for the targeted `{ academyId: null, belt }`
 * lookup — any other call (e.g. a concurrent test's lookup for a different
 * belt) falls through to the real implementation untouched. Restores the
 * original implementation in `finally` regardless of outcome, and never
 * touches real seeded `BeltRequirement` rows, so it can't leak into other
 * concurrently-running test files.
 */
async function withMissingGlobalBeltRequirement<T>(belt: Belt, fn: () => Promise<T>): Promise<T> {
  const beltRequirementDelegate = appPrisma.beltRequirement as unknown as {
    findFirstOrThrow: (...args: unknown[]) => Promise<unknown>;
  };
  const originalFindFirstOrThrow = beltRequirementDelegate.findFirstOrThrow.bind(beltRequirementDelegate);
  beltRequirementDelegate.findFirstOrThrow = async (...args: unknown[]) => {
    const arg = args[0] as { where?: { academyId?: string | null; belt?: Belt } } | undefined;
    if (arg?.where?.academyId === null && arg.where.belt === belt) {
      throw Object.assign(
        new Error(
          "An operation failed because it depends on one or more records that were required but not found.",
        ),
        { name: "PrismaClientKnownRequestError", code: "P2025", clientVersion: "test" },
      );
    }
    return originalFindFirstOrThrow(...args);
  };
  try {
    return await fn();
  } finally {
    beltRequirementDelegate.findFirstOrThrow = originalFindFirstOrThrow;
  }
}

describe("promotion queue", () => {
  afterAll(cleanup);

  it("a student exactly at a stripe threshold appears in listPromotionQueue as stripe-eligible", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
    const student = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // WHITE requires 30 attendancesPerStripe (global default) — exactly at
    // the threshold, not one short and not one over.
    await addAttendances(student.id, escazu.id, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const candidate = findCandidate(queue, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("stripe-eligible");
    expect(candidate?.atBeltCount).toBe(30);
    expect(candidate?.remainingToNextStripe).toBe(0);
    expect(candidate?.currentBelt).toBe("WHITE");
    expect(candidate?.currentStripes).toBe(0);
    expect(candidate?.homeAcademyName).toBe(escazu.name);

    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student exactly at the exam threshold (4 stripes, attendancesForExam more) appears as exam-eligible", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-02-01T12:00:00Z");
    // beltAwardedAt marks when the BELT (not the 4th stripe) was awarded, so
    // atBeltCount accrues from there across all 4 stripes too —
    // computeBeltProgress's attendancesIntoCurrentStripeSpan subtracts
    // currentStripes * attendancesPerStripe (4 * 30 = 120) back out. Exactly
    // at the exam threshold means 120 (the 4 stripes) + 30 (WHITE's
    // attendancesForExam) = 150 total, matching attendance-summary.test.ts's
    // equivalent fixture and the schema's own comment on this field.
    const student = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 4, beltAwardedAt });

    await addAttendances(student.id, escazu.id, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const candidate = findCandidate(queue, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("exam-eligible");
    expect(candidate?.atBeltCount).toBe(150);
    expect(candidate?.remainingToNextStripe).toBeNull();

    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student 3 attendances from a threshold appears ONLY in listApproachingStudents", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-03-01T12:00:00Z");
    const student = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // 30 - 3 = 27: 3 attendances short of the next stripe.
    await addAttendances(student.id, escazu.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const approaching = await listApproachingStudents(admin);
    const candidate = findCandidate(approaching, student.id);
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("approaching");
    expect(candidate?.remainingToNextStripe).toBe(3);

    const queue = await listPromotionQueue(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
  });

  it("a student 20 attendances from any threshold appears in neither list", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-04-01T12:00:00Z");
    const student = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // 30 - 20 = 10: 20 attendances short of the next stripe, beyond the
    // default 5-attendance "approaching" window.
    await addAttendances(student.id, escazu.id, 10, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a DIRECTOR/INSTRUCTOR session scoped to Escazú never sees an Escalante-only eligible student; ADMIN sees both", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const beltAwardedAt = new Date("2026-05-01T12:00:00Z");
    const escazuStudent = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    const escalanteStudent = await makeStudent(escalante.id, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
    });

    // Both exactly stripe-eligible.
    await Promise.all([
      addAttendances(escazuStudent.id, escazu.id, 30, new Date(beltAwardedAt.getTime() + DAY_MS)),
      addAttendances(escalanteStudent.id, escalante.id, 30, new Date(beltAwardedAt.getTime() + DAY_MS)),
    ]);

    const escazuInstructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [escazu.id] };
    const scopedQueue = await listPromotionQueue(escazuInstructor);
    expect(findCandidate(scopedQueue, escazuStudent.id)).toBeDefined();
    expect(findCandidate(scopedQueue, escalanteStudent.id)).toBeUndefined();

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const fullQueue = await listPromotionQueue(admin);
    expect(findCandidate(fullQueue, escazuStudent.id)).toBeDefined();
    expect(findCandidate(fullQueue, escalanteStudent.id)).toBeDefined();
  });

  it("a Black-belt student at any attendance count appears in neither list", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-06-01T12:00:00Z");
    // BLACK's global default requirement is 0/0/0 — maxStripes 0 means
    // currentStripes (0) already meets/exceeds it, and attendancesForExam 0
    // means computeBeltProgress never marks examEligible. classifyEligibility
    // should report "none" no matter how many attendances pile up.
    const student = await makeStudent(escazu.id, { currentBelt: "BLACK", currentStripes: 0, beltAwardedAt });

    await addAttendances(student.id, escazu.id, 500, new Date(beltAwardedAt.getTime() + DAY_MS));

    const queue = await listPromotionQueue(admin);
    const approaching = await listApproachingStudents(admin);
    expect(findCandidate(queue, student.id)).toBeUndefined();
    expect(findCandidate(approaching, student.id)).toBeUndefined();
  });

  it("a student hard-deleted between the admin-wide scan and its own per-row lookup is excluded from listPromotionQueue/listApproachingStudents without throwing, and without losing any OTHER student's result", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-07-01T12:00:00Z");

    // listPromotionQueue: a genuinely stripe-eligible survivor sharing the
    // same batch as a student that vanishes mid-scan.
    const survivor = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(survivor.id, escazu.id, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
    const vanishing = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    const queue = await withStudentVanishingAfterScan(vanishing.id, () => listPromotionQueue(admin));
    expect(findCandidate(queue, vanishing.id)).toBeUndefined();
    const survivorInQueue = findCandidate(queue, survivor.id);
    expect(survivorInQueue).toBeDefined();
    expect(survivorInQueue?.status).toBe("stripe-eligible");

    // listApproachingStudents: same race, a fresh vanishing student (the
    // first is already gone for real now, which wouldn't exercise the race
    // a second time) alongside a genuinely "approaching" survivor.
    const survivor2 = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(survivor2.id, escazu.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));
    const vanishing2 = await makeStudent(escazu.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    const approaching = await withStudentVanishingAfterScan(vanishing2.id, () => listApproachingStudents(admin));
    expect(findCandidate(approaching, vanishing2.id)).toBeUndefined();
    const survivor2InApproaching = findCandidate(approaching, survivor2.id);
    expect(survivor2InApproaching).toBeDefined();
    expect(survivor2InApproaching?.status).toBe("approaching");
  });

  it("a genuinely missing global BeltRequirement row for a belt propagates loudly instead of being silently excluded like a vanished student", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const beltAwardedAt = new Date("2026-08-01T12:00:00Z");
    // PURPLE has no per-academy override seeded for Escazú — only the global
    // default applies — so simulating that global row's absence actually
    // exercises `resolveBeltRequirementLike`'s `findFirstOrThrow` fallback
    // rather than short-circuiting on a per-academy override first.
    const student = await makeStudent(escazu.id, { currentBelt: "PURPLE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, 10, new Date(beltAwardedAt.getTime() + DAY_MS));

    // As of fix round 3, `resolveBeltRequirementLike`/`resolveBeltRequirement`
    // catch this lookup's P2025 and rethrow a distinctly-typed
    // `MissingBeltRequirementError` instead — see promotion-queue.ts's
    // `classifyActiveStudents` for why call-site discrimination (round 2)
    // was replaced with type discrimination. The propagation itself is
    // unchanged: it still fails the whole batch loudly.
    await expect(
      withMissingGlobalBeltRequirement("PURPLE", () => listPromotionQueue(admin)),
    ).rejects.toMatchObject({ name: "MissingBeltRequirementError" });

    await expect(
      withMissingGlobalBeltRequirement("PURPLE", () => listApproachingStudents(admin)),
    ).rejects.toMatchObject({ name: "MissingBeltRequirementError" });
  });
});
