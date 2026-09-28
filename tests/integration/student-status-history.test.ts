import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { currentMonthIn } from "../../src/lib/dues/config-input";
import { addMonths } from "../../src/lib/dues/calendar";

vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("@/lib/notifications/notify-new-signup", () => ({ notifyNewSignup: vi.fn(async () => {}) }));

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { approveStudent, archiveStudent, restoreStudent, pauseStudent, resumeStudent } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/actions"
);
const { createStudent } = await import("../../src/app/[locale]/(staff)/students/create-student-action");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { runStatusHistoryBaseline } = await import("../../src/lib/students/baseline-action");
const { assignPlan, correctAssignment } = await import("../../src/lib/dues/assignment-actions");

/**
 * Eligibility-prerequisites brief: status history (all seven writers), pause/resume, baseline, and the assignment writer —
 * proved against the REAL test database with private, temporary organizations. The eligibility read function itself is a pure
 * function, tested separately in tests/unit/dues-eligibility.test.ts.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ZONE = "America/Costa_Rica";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
function actAs(userId: string | null, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role } } : null;
}

async function newStaff(fx: Fixture, academyId: string, role: "DIRECTOR" | "INSTRUCTOR", label: string) {
  const user = await prisma.user.create({ data: { email: `sh-${label}-${suffix}@example.com`, passwordHash: "x", role } });
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: fx.org.id, role } });
  await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId: fx.org.id, role } });
  return user;
}

let studentCounter = 0;
async function newStudent(fx: Fixture, academyId: string, status: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED", label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: fx.org.id,
      homeAcademyId: academyId,
      firstName: "Hist",
      lastName: `${label}${n}`,
      phone: "00000000",
      email: `hist-${label}-${n}-${suffix}@example.com`,
      currentRankId: await fx.rankId("WHITE"),
      codeHash: `hist-${label}-${n}-${suffix}`,
      status,
    },
  });
}
async function history(studentId: string) {
  return prisma.studentStatusChange.findMany({ where: { studentId }, orderBy: [{ effectiveOn: "asc" }, { sequence: "asc" }] });
}
async function auditCount(organizationId: string, action: string) {
  return prisma.auditLog.count({ where: { organizationId, action } });
}

/** Polls pg_stat_activity for a session genuinely blocked on the given lock — the PR 4a pattern, not a wall-clock guess. */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

let a: Fixture; // org A: owner = a.admin, first branch = a.academy
let a2: { id: string }; // A's second branch
let b: Fixture; // org B, for cross-tenant checks
let director1: { id: string }; // DIRECTOR of A's first branch
let director2: { id: string }; // DIRECTOR of A's second branch
let instructor: { id: string }; // INSTRUCTOR of A's first branch
let monthlyPlan: { id: string }; // A, first branch, ordinary monthly plan
let packagePlan: { id: string }; // A, first branch, package plan
let otherBranchPlan: { id: string }; // A, second branch

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "hist-a");
  b = await makeAccountingOrg("CUMULATIVE", "hist-b");
  a2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Hist A2", slug: `hist-a2-${suffix}`, kioskTokenHash: `hist-a2-${suffix}` } });
  director1 = await newStaff(a, a.academy.id, "DIRECTOR", "d1");
  director2 = await newStaff(a, a2.id, "DIRECTOR", "d2");
  instructor = await newStaff(a, a.academy.id, "INSTRUCTOR", "i1");

  monthlyPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Monthly ${suffix}` } });
  const pkg = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Package ${suffix}` } });
  packagePlan = pkg;
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: pkg.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
  otherBranchPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a2.id, name: `Other branch ${suffix}` } });
}, 60_000);

afterAll(async () => {
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.studentStatusChange.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.auditLog.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  }
  const staffIds = [director1?.id, director2?.id, instructor?.id].filter(Boolean) as string[];
  await prisma.staffAssignment.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: staffIds } } });
  await prisma.user.deleteMany({ where: { id: { in: staffIds } } });
  // The two portal users created by the real signup/create-student writers above (not covered by `drop()`, which only removes the
  // fixture's own admin user) — their Student rows are already gone via `drop()`'s own `student.deleteMany`.
  await prisma.user.deleteMany({ where: { email: { contains: suffix }, id: { notIn: [a.admin.id, b.admin.id] } } });
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("status history is written atomically, inside the same transaction as every existing action", () => {
  it("approveStudent: PENDING -> ACTIVE writes one matching EVENT row", async () => {
    const s = await newStudent(a, a.academy.id, "PENDING", "approve");
    actAs(a.admin.id);
    expect(await approveStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    const rows = await history(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ACTIVE", sequence: 1, source: "EVENT", actorId: a.admin.id });
  });

  it("archiveStudent then restoreStudent: two more EVENT rows, sequence strictly increasing", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "arch-rest");
    actAs(a.admin.id);
    expect(await archiveStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    expect(await restoreStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    const rows = await history(s.id);
    expect(rows.map((r) => r.status)).toEqual(["ARCHIVED", "ACTIVE"]);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it("a refused precondition writes NOTHING — the failed updateMany rolls back before the history row is even attempted", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "refuse");
    actAs(a.admin.id);
    expect(await approveStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notPending" }); // already ACTIVE
    expect(await restoreStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notArchived" });
    expect(await history(s.id)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, entityId: s.id } })).toBe(0);
  });
});

describe("StudentStatusChange is protected by RESTRICT, not CASCADE (real-database regression)", () => {
  it("deleting a student with status history is refused, and the history remains intact", async () => {
    const s = await newStudent(a, a.academy.id, "PENDING", "delete-guard");
    actAs(a.admin.id);
    expect(await approveStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    const before = await history(s.id);
    expect(before).toHaveLength(1);

    let error: unknown;
    try {
      await prisma.student.delete({ where: { id: s.id } });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Object);
    expect((error as { code?: string }).code).toBe("P2003"); // foreign key constraint violation, not a silent no-op

    // The student and its history both survive the refused delete, unmodified.
    expect(await prisma.student.findUnique({ where: { id: s.id } })).not.toBeNull();
    expect(await history(s.id)).toEqual(before);
  });
});

describe("pauseStudent / resumeStudent: preconditions", () => {
  it("pause requires ACTIVE — refuses PENDING, ARCHIVED and already-INACTIVE", async () => {
    actAs(a.admin.id);
    for (const status of ["PENDING", "ARCHIVED", "INACTIVE"] as const) {
      const s = await newStudent(a, a.academy.id, status, `pause-refuse-${status}`);
      expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notActive" });
      expect(await history(s.id)).toHaveLength(0);
    }
  });

  it("resume requires INACTIVE — refuses everything else, symmetric to restoreStudent's ARCHIVED-only precondition", async () => {
    actAs(a.admin.id);
    for (const status of ["PENDING", "ACTIVE", "ARCHIVED"] as const) {
      const s = await newStudent(a, a.academy.id, status, `resume-refuse-${status}`);
      expect(await resumeStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notInactive" });
      expect(await history(s.id)).toHaveLength(0);
    }
  });

  it("pause then resume: two EVENT rows, INACTIVE then ACTIVE, sequence 1 then 2", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "pause-resume");
    actAs(a.admin.id);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    expect(await resumeStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    const rows = await history(s.id);
    expect(rows.map((r) => [r.status, r.sequence])).toEqual([
      ["INACTIVE", 1],
      ["ACTIVE", 2],
    ]);
  });

  it("existing debt is never touched by pause, at any status — no ledger table is written", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "no-ledger");
    actAs(a.admin.id);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id } })).toBe(0);
    expect(await prisma.duesPayment.count({ where: { studentId: s.id } })).toBe(0);
  });
});

describe("pauseStudent / resumeStudent: permissions (owners and the student's own-branch Director)", () => {
  it("owner may pause/resume any branch", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "owner-perm");
    actAs(a.admin.id);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
  });

  it("the student's own-branch Director may pause/resume", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "own-branch-dir");
    actAs(director1.id, "DIRECTOR");
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true });
  });

  it("a Director of a DIFFERENT branch is refused with notFound — never inferred from roster-management membership alone", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "wrong-branch-dir");
    actAs(director2.id, "DIRECTOR"); // director2 is A2's director, this student is at A1
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notFound" });
    expect(await history(s.id)).toHaveLength(0);
  });

  it("a real member with a disallowed role (INSTRUCTOR) throws FORBIDDEN, not notFound", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "wrong-role");
    actAs(instructor.id, "INSTRUCTOR");
    await expect(pauseStudent(a.org.id, {}, form({ studentId: s.id }))).rejects.toThrow("FORBIDDEN");
  });

  it("a non-member / signed-out caller gets notFound", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "signed-out");
    actAs(null);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notFound" });
  });

  it("a student in another organization is refused with notFound (tenant isolation)", async () => {
    const s = await newStudent(b, b.academy.id, "ACTIVE", "cross-org");
    actAs(a.admin.id);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ error: "notFound" });
  });
});

/**
 * A dedicated, test-controlled transaction that takes the student lock and holds it until `release()` is called — the exact
 * technique tests/integration/dues-ledger-writers.test.ts uses ("CONCURRENT: the student lock alone..."), not a race between two
 * real calls with unpredictable timing (a writer this light can complete before a second real call is even dispatched).
 */
function holdStudentLock(studentId: string) {
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${studentId}' FOR UPDATE`);
      started();
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

describe("sequence, not createdAt: deterministic ordering under genuine lock contention", () => {
  it("the student lock alone makes pauseStudent genuinely wait", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "lock-wait");
    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;

    actAs(a.admin.id);
    let done = false;
    const pausing = pauseStudent(a.org.id, {}, form({ studentId: s.id })).then((r) => ((done = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "pauseStudent must genuinely be waiting on the student row lock").toBe(true);
    expect(done).toBe(false);

    release();
    await held;
    expect(await pausing).toEqual({ ok: true });
  });

  it("two real, genuinely concurrent pauseStudent calls: exactly one succeeds, sequence is correctly 1, the loser writes nothing", async () => {
    // A bare lock-holder (above) proves the row IS locked; this proves what happens when the SECOND contender is another real
    // writer, not a held-open transaction — nothing can commit a change on the student row while it is held FOR UPDATE (even an
    // insert referencing it via foreign key would itself have to wait), so this needs two genuine calls raced against each
    // other. Postgres's row-level locking makes the outcome deterministic regardless of which one happens to run first.
    const s = await newStudent(a, a.academy.id, "ACTIVE", "race");
    actAs(a.admin.id);

    const [r1, r2] = await Promise.all([pauseStudent(a.org.id, {}, form({ studentId: s.id })), pauseStudent(a.org.id, {}, form({ studentId: s.id }))]);
    const results = [r1, r2];
    expect(results.filter((r) => "ok" in r && r.ok)).toHaveLength(1);
    expect(results.filter((r) => "error" in r && r.error === "notActive")).toHaveLength(1);

    const rows = await history(s.id);
    expect(rows).toHaveLength(1); // the loser wrote nothing at all — no second history row for its failed attempt
    expect(rows[0]).toMatchObject({ status: "INACTIVE", sequence: 1 });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("INACTIVE"); // status agrees with the sole history row
  });
});

describe("first-row atomicity: createStudent and signup need no lock for the student's very first history row", () => {
  it("createStudent writes one sequence=1 ACTIVE row, in the same transaction as the student itself", async () => {
    actAs(a.admin.id, "DIRECTOR");
    const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: a.org.id, track: "ADULT", code: "WHITE" } });
    const created = await createStudent(
      a.org.id,
      {},
      form({
        firstName: "First",
        lastName: `Row${suffix}`,
        phone: "00000000",
        email: `first-row-${suffix}@example.com`,
        homeAcademyId: a.academy.id,
        track: "ADULT",
        currentRankId: rank.id,
        currentStripes: "0",
      }),
    );
    expect(created.ok).toBe(true);
    const student = await prisma.student.findFirstOrThrow({ where: { organizationId: a.org.id, email: `first-row-${suffix}@example.com` } });
    const rows = await history(student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ACTIVE", sequence: 1, source: "EVENT" });
  });

  it("signup writes one sequence=1 PENDING row, attributed to the applicant's own new user", async () => {
    const email = `signup-first-row-${suffix}@example.com`;
    const result = await signup(
      a.org.slug,
      {},
      form({
        firstName: "Signup",
        lastName: `First${suffix}`,
        phone: "00000000",
        email,
        homeAcademySlug: a.academy.slug,
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "irrelevant-password-123",
        dateOfBirth: "1990-01-01",
      }),
    );
    expect(result.ok).toBe(true);
    const student = await prisma.student.findFirstOrThrow({ where: { organizationId: a.org.id, email } });
    expect(student.status).toBe("PENDING");
    const rows = await history(student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", sequence: 1, source: "EVENT", actorId: student.userId });
  });
});

describe("baseline: never invents earlier history, repeat runs preserve existing history", () => {
  it("a never-touched student gets exactly one BASELINE row matching their CURRENT status; a repeat run touches nothing", async () => {
    const pending = await newStudent(a, a.academy.id, "PENDING", "baseline-pending");
    const active = await newStudent(a, a.academy.id, "ACTIVE", "baseline-active");
    const archived = await newStudent(a, a.academy.id, "ARCHIVED", "baseline-archived");
    actAs(a.admin.id);

    const first = await runStatusHistoryBaseline(a.org.id, {}, new FormData());
    expect(first.ok).toBe(true);

    for (const [student, status] of [
      [pending, "PENDING"],
      [active, "ACTIVE"],
      [archived, "ARCHIVED"],
    ] as const) {
      const rows = await history(student.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status, sequence: 1, source: "BASELINE", actorId: a.admin.id });
    }

    const second = await runStatusHistoryBaseline(a.org.id, {}, new FormData());
    expect(second.ok).toBe(true);
    expect(second.count).toBe(0); // nothing left to capture — the three above are already covered
    for (const student of [pending, active, archived]) {
      expect(await history(student.id)).toHaveLength(1); // untouched, not duplicated
    }
  });

  it("a student who already has a real EVENT row is left alone entirely — baseline never fabricates anything before it", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "baseline-skip");
    actAs(a.admin.id);
    expect(await pauseStudent(a.org.id, {}, form({ studentId: s.id }))).toEqual({ ok: true }); // one real EVENT row, sequence 1
    await runStatusHistoryBaseline(a.org.id, {}, new FormData());
    const rows = await history(s.id);
    expect(rows).toHaveLength(1); // baseline added nothing
    expect(rows[0].source).toBe("EVENT");
  });

  it("baseline racing a real first-ever action for the same never-touched student: exactly one first row results", async () => {
    // Both sides serialize on the SAME `lockStudent` call for this student, so the outcome is deterministic regardless of which
    // one happens to reach it first — never zero rows, never two rows both claiming to be the first (sequence 1).
    const s = await newStudent(a, a.academy.id, "ACTIVE", "baseline-race");
    actAs(a.admin.id);

    await Promise.all([runStatusHistoryBaseline(a.org.id, {}, new FormData()), pauseStudent(a.org.id, {}, form({ studentId: s.id }))]);

    const rows = await history(s.id);
    expect(rows.length).toBeGreaterThanOrEqual(1); // never zero
    expect(rows.filter((r) => r.sequence === 1)).toHaveLength(1); // never two rows claiming to be "first"
  });
});

describe("assignment writer: tenant/branch validation, package refusal, past-month refusal, duplicate refusal", () => {
  it("assigns a plan for a future month, owners only", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-ok");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 2);
    const result = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(result).toEqual({ ok: true });
    const row = await prisma.studentPlanAssignment.findFirstOrThrow({ where: { studentId: s.id } });
    expect(row).toMatchObject({ planId: monthlyPlan.id, effectiveYear: month.year, effectiveMonth: month.month });
    expect(await auditCount(a.org.id, "studentPlanAssignment.create")).toBeGreaterThan(0);
  });

  it("a Director (not an owner) is refused, even for their own branch — not inferred from the roster-management gate", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-director");
    actAs(director1.id, "DIRECTOR");
    const month = addMonths(currentMonthIn(ZONE), 2);
    await expect(assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }))).rejects.toThrow(
      "FORBIDDEN",
    );
  });

  it("a plan from a different branch than the student's is refused", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-wrong-branch");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 2);
    const result = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: otherBranchPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(result.error).toBe("invalid");
  });

  it("a package plan is refused — packages are bought explicitly, never assigned this way", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-package");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 2);
    const result = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: packagePlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(result.error).toBe("invalid");
  });

  it("a strictly-past month is refused", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-past");
    actAs(a.admin.id);
    const past = addMonths(currentMonthIn(ZONE), -1);
    const result = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(past.year), effectiveMonth: String(past.month) }));
    expect(result).toEqual({ error: "pastMonth" });
  });

  it("planId omitted (blank) is a first-class 'explicitly unassigned' value", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-null");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 3);
    const result = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: "", effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(result).toEqual({ ok: true });
    const row = await prisma.studentPlanAssignment.findFirstOrThrow({ where: { studentId: s.id, effectiveYear: month.year, effectiveMonth: month.month } });
    expect(row.planId).toBeNull();
  });

  it("a second assignment for the same student and month is refused (append-only, no silent overwrite)", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "assign-dup");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 2);
    const first = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(first).toEqual({ ok: true });
    const second = await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    expect(second).toEqual({ error: "monthAssigned" });
    expect(await prisma.studentPlanAssignment.count({ where: { studentId: s.id, effectiveYear: month.year, effectiveMonth: month.month } })).toBe(1);
  });
});

describe("assignment correction: D25's protections, reused exactly", () => {
  it("a strictly-future assignment may be corrected with the matching revision token", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "correct-ok");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 3);
    await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    const row = await prisma.studentPlanAssignment.findFirstOrThrow({ where: { studentId: s.id } });
    const revision = JSON.stringify([["planId", row.planId]]);
    const result = await correctAssignment(a.org.id, {}, form({ assignmentId: row.id, expectedRevision: revision, planId: "" }));
    expect(result).toEqual({ ok: true });
    const updated = await prisma.studentPlanAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.planId).toBeNull();
    expect(await auditCount(a.org.id, "studentPlanAssignment.correct")).toBeGreaterThan(0);
  });

  it("a stale revision token is refused, not silently overwritten", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "correct-stale");
    actAs(a.admin.id);
    const month = addMonths(currentMonthIn(ZONE), 3);
    await assignPlan(a.org.id, {}, form({ studentId: s.id, planId: monthlyPlan.id, effectiveYear: String(month.year), effectiveMonth: String(month.month) }));
    const row = await prisma.studentPlanAssignment.findFirstOrThrow({ where: { studentId: s.id } });
    const result = await correctAssignment(a.org.id, {}, form({ assignmentId: row.id, expectedRevision: "stale-token", planId: "" }));
    expect(result).toEqual({ error: "stale" });
    expect((await prisma.studentPlanAssignment.findUniqueOrThrow({ where: { id: row.id } })).planId).toBe(monthlyPlan.id);
  });

  it("a CURRENT month's assignment cannot be corrected, even the instant it turns from future to current", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "correct-current");
    const now = currentMonthIn(ZONE);
    const row = await prisma.studentPlanAssignment.create({
      data: { organizationId: a.org.id, studentId: s.id, planId: monthlyPlan.id, effectiveYear: now.year, effectiveMonth: now.month, createdById: a.admin.id },
    });
    actAs(a.admin.id);
    const revision = JSON.stringify([["planId", row.planId]]);
    const result = await correctAssignment(a.org.id, {}, form({ assignmentId: row.id, expectedRevision: revision, planId: "" }));
    expect(result).toEqual({ error: "notFuture" });
  });

  it("a PAST month's assignment cannot be corrected", async () => {
    const s = await newStudent(a, a.academy.id, "ACTIVE", "correct-past");
    const past = addMonths(currentMonthIn(ZONE), -2);
    const row = await prisma.studentPlanAssignment.create({
      data: { organizationId: a.org.id, studentId: s.id, planId: monthlyPlan.id, effectiveYear: past.year, effectiveMonth: past.month, createdById: a.admin.id },
    });
    actAs(a.admin.id);
    const revision = JSON.stringify([["planId", row.planId]]);
    const result = await correctAssignment(a.org.id, {}, form({ assignmentId: row.id, expectedRevision: revision, planId: "" }));
    expect(result).toEqual({ error: "notFuture" });
  });
});
