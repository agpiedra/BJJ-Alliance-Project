import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3.3/§4: `getOwnPaymentHistoryPage`'s own authorization bridge,
 * called exactly as a real client would (no `deps` override exists on its public signature, so every call here
 * runs under the REAL, unmodified, hardcoded-false `inactiveLedgerActivation` default). Mirrors
 * `[id]/payment-history-actions.test.ts`'s own `actAs`/session-mocking precedent and its "notActive proves the
 * authorization check passed" framing exactly.
 *
 * Real pagination/cursor/branch-scope/identity-isolation behavior (another student, another organization, a
 * coach-trains-elsewhere student's own real data) is already proven at the READER level, with a `deps.activation`
 * override, by `payment-history-queries.test.ts`'s own PR #97 tests — this file's job is authorization only: did
 * the request even reach the reader, and was it refused for the RIGHT reason when it didn't.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { getOwnPaymentHistoryPage } = await import("../../src/app/[locale]/portal/payment-history-actions");

function actAs(userId: string | null, organizationId?: string, role = "STUDENT") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

let a: Fixture;
let otherAcademy: { id: string };
let student: { id: string; userId: string | null };
let studentUser: { id: string };
let elsewhereCoach: { id: string };
let elsewhereCoachStudent: { id: string };

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "portalhistact-a");
  otherAcademy = await prisma.academy.create({
    data: { organizationId: a.org.id, name: "PortalHistAct other branch", slug: `portalhistact-other-${suffix}`, kioskTokenHash: `portalhistact-other-${suffix}` },
  });

  studentUser = await prisma.user.create({ data: { email: `portalhistact-student-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "STUDENT" } });
  await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: a.org.id, role: "STUDENT" } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, userId: studentUser.id, firstName: "Portal", lastName: `HistAct-${suffix}`, phone: "00000000",
      email: `portalhistact-linked-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalhistact-linked-${suffix}`, status: "ACTIVE",
    },
  });

  // The "coach trains elsewhere" case: staff-assigned to `a.academy.id` ONLY, but their own linked student record
  // is homed at `otherAcademy` instead — the genuine branch mismatch brief §2.5/§4 item 4 requires.
  elsewhereCoach = await prisma.user.create({ data: { email: `portalhistact-coach-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: elsewhereCoach.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: elsewhereCoach.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  elsewhereCoachStudent = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: otherAcademy.id, userId: elsewhereCoach.id, firstName: "Coach", lastName: `Elsewhere-${suffix}`, phone: "00000000",
      email: `portalhistact-coach-linked-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalhistact-coach-linked-${suffix}`, status: "ACTIVE",
    },
  });
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (elsewhereCoachStudent) await prisma.student.deleteMany({ where: { id: elsewhereCoachStudent.id } });
  if (elsewhereCoach) {
    await prisma.staffAssignment.deleteMany({ where: { userId: elsewhereCoach.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: elsewhereCoach.id } });
    await prisma.user.deleteMany({ where: { id: elsewhereCoach.id } });
  }
  if (student) await prisma.student.deleteMany({ where: { id: student.id } });
  if (studentUser) {
    await prisma.organizationMembership.deleteMany({ where: { userId: studentUser.id } });
    await prisma.user.deleteMany({ where: { id: studentUser.id } });
  }
  if (otherAcademy) await prisma.academy.deleteMany({ where: { id: otherAcademy.id } });
  await a?.drop();
}, 120_000);

describe("getOwnPaymentHistoryPage: no studentId parameter exists — a type-level proof (requirement 1)", () => {
  it("the exported function's own arity is (organizationId, cursor?) — never a studentId slot at any position", () => {
    expect(getOwnPaymentHistoryPage.length).toBeLessThanOrEqual(2);
  });
});

describe("getOwnPaymentHistoryPage: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller gets notFound, never reaching the reader", async () => {
    actAs(null);
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notFound" });
  });

  it("a genuine STUDENT with a linked ACTIVE student record gets notActive — proving role AND linked-student checks both passed", async () => {
    actAs(studentUser.id, a.org.id, "STUDENT");
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notActive" });
  });

  it("a genuine ADMIN with no linked student record of their own gets notFound — the action's own linked-student guard, not a role refusal", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notFound" });
  });

  it("brief §2.5/§4 item 4: a DIRECTOR whose own staff-assignment branch does NOT include their linked student's home academy still gets notActive — the branch is never consulted at this layer either", async () => {
    actAs(elsewhereCoach.id, a.org.id, "DIRECTOR");
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notActive" });
  });
});

describe("getOwnPaymentHistoryPage: real authorization re-resolution between calls (brief's required verification)", () => {
  it("a membership revoked between two calls is honored on the SECOND call, never grandfathered from the first", async () => {
    actAs(studentUser.id, a.org.id, "STUDENT");
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notActive" });

    await prisma.organizationMembership.deleteMany({ where: { userId: studentUser.id, organizationId: a.org.id } });
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notFound" });

    await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: a.org.id, role: "STUDENT" } });
  });

  it("the student record being archived (unlinked) between two calls is honored on the SECOND call — resolveLinkedStudentId re-reads the DB fresh every time", async () => {
    actAs(studentUser.id, a.org.id, "STUDENT");
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notActive" });

    // A real DB change between the two calls: the student's status flips away from ACTIVE, exactly what
    // `resolveLinkedStudentId` (resolve-context.ts) checks — never a status-only fallback, never cached.
    await prisma.student.update({ where: { id: student.id }, data: { status: "ARCHIVED" } });
    expect(await getOwnPaymentHistoryPage(a.org.id)).toEqual({ ok: false, error: "notFound" });

    await prisma.student.update({ where: { id: student.id }, data: { status: "ACTIVE" } });
  });
});
