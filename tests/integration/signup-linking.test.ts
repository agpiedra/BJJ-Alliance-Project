import "dotenv/config";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { signup } from "../../src/app/[locale]/signup/actions";

// I-1 regression coverage: notifyNewSignup must still fire when a new
// student signs up through this REAL server action entry point (not just via
// a direct notifyNewSignup call) — the seam Fix 1 (after()-wrapped
// fire-and-forget) touches. Mocked so this file doesn't depend on/pollute
// real staff Notification rows or make a real Resend call.
const notifyNewSignupState = vi.hoisted(() => ({ spy: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("../../src/lib/notifications/notify-new-signup", () => ({
  notifyNewSignup: (...args: unknown[]) => notifyNewSignupState.spy(...args),
}));

// `signup` is a genuinely anonymous action — no session, no cookies — so it
// can be imported and called directly, unlike the staff actions.
const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

const cleanupEmails: string[] = [];

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

describe("signup — a staff-created student's email is REFUSED, never duplicated and never auto-claimed", () => {
  afterEach(() => notifyNewSignupState.spy.mockClear());

  afterAll(async () => {
    const students = await prisma.student.findMany({
      where: { email: { in: cleanupEmails } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: students.map((s) => s.id) } } });
    await prisma.student.deleteMany({ where: { email: { in: cleanupEmails } } });
    await prisma.user.deleteMany({ where: { email: { in: cleanupEmails } } });
  });

  it("refuses the signup, creates no User, and leaves the existing userId-less Student completely untouched", async () => {
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const email = `signup-link-${suffix}@example.com`;
    cleanupEmails.push(email);

    // Staff entered this student by hand: PURPLE belt, 3 stripes, Escalante,
    // and a 4-digit code they already handed over. No portal account yet.
    const staffCodeHash = digestLookupSecret(`signup-link-${suffix}`, pepper);
    const staffCreated = await prisma.student.create({
      data: {
        homeAcademyId: escalante.id,
        firstName: "StaffEntered",
        lastName: "Purple",
        phone: "88887777",
        email,
        currentBelt: "PURPLE",
        currentStripes: 3,
        codeHash: staffCodeHash,
        status: "ACTIVE",
        userId: null,
      },
    });

    // Someone self-registers at that email. In this phase nothing has proved
    // they control it, so this must NOT hand them the existing record — that
    // would be account takeover by email guess, on a row that is already
    // ACTIVE and would therefore skip staff review entirely.
    const result = await signup(
      {},
      formData({
        firstName: "SelfSignup",
        lastName: "Attempt",
        phone: "88886666",
        email,
        homeAcademySlug: "escazu",
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "a-sufficiently-long-password",
      }),
    );

    // (a) the new, explicit refusal — not a success, not a silent link
    expect(result.ok).toBeUndefined();
    expect(result.code).toBeUndefined();
    expect(result.error).toBe("emailLinkedToExistingStudent");
    expect(result.fieldErrors?.email).toEqual(["emailLinkedToExistingStudent"]);

    // (b) NO User row was created at that email
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    // (c) the existing Student row is completely unchanged — still exactly
    //     one row, still unclaimed, every field as staff left it
    const students = await prisma.student.findMany({ where: { email } });
    expect(students).toHaveLength(1);
    const untouched = students[0];
    expect(untouched.id).toBe(staffCreated.id);
    expect(untouched.userId).toBeNull();
    expect(untouched.codeHash).toBe(staffCodeHash);
    expect(untouched.currentBelt).toBe("PURPLE");
    expect(untouched.currentStripes).toBe(3);
    expect(untouched.homeAcademyId).toBe(escalante.id);
    expect(untouched.status).toBe("ACTIVE");
    expect(untouched.firstName).toBe("StaffEntered");
    expect(untouched.lastName).toBe("Purple");
    expect(untouched.phone).toBe("88887777");
    // `updatedAt` proves no write touched the row at all, not merely that the
    // values happen to match.
    expect(untouched.updatedAt.getTime()).toBe(staffCreated.updatedAt.getTime());

    // Nothing was written, so there is nothing to audit — in particular the
    // old `student.linkedSelfSignup` event no longer exists on any path.
    expect(await prisma.auditLog.count({ where: { entityId: staffCreated.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "student.linkedSelfSignup" } })).toBe(0);
  });

  it("still creates both rows normally when no staff-created record exists at that email", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const email = `signup-fresh-${suffix}@example.com`;
    cleanupEmails.push(email);

    const result = await signup(
      {},
      formData({
        firstName: "Fresh",
        lastName: "Signup",
        phone: "88885555",
        email,
        homeAcademySlug: "escazu",
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "a-sufficiently-long-password",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.code).toMatch(/^\d{4}$/);

    const students = await prisma.student.findMany({ where: { email } });
    expect(students).toHaveLength(1);
    expect(students[0].status).toBe("PENDING");
    expect(students[0].userId).not.toBeNull();
    expect(students[0].codeHash).toBe(digestLookupSecret(result.code!, pepper));

    // I-1: fires through the REAL signup action entry point, not just when
    // notifyNewSignup is called directly (see notify-new-signup.test.ts).
    expect(notifyNewSignupState.spy).toHaveBeenCalledWith(students[0].id);
  });

  it("a student whose row is ALREADY claimed cannot signup again (the User email is taken)", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const email = `signup-dupe-${suffix}@example.com`;
    cleanupEmails.push(email);

    const base = {
      firstName: "Dupe",
      lastName: "Attempt",
      phone: "88884444",
      email,
      homeAcademySlug: "escazu",
      currentBelt: "WHITE",
      currentStripes: "0",
      password: "a-sufficiently-long-password",
    };

    expect((await signup({}, formData(base))).ok).toBe(true);
    // The first signup set `userId`, so the userId-less lookup misses and the
    // pre-existing `emailTaken` User check is what refuses this one.
    const second = await signup({}, formData(base));
    expect(second.error).toBe("emailTaken");
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });

  it("rejects a firstName/lastName over 100 chars (bundled minor fix — an unbounded name reaches Resend's email subject line)", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const email = `signup-longname-${suffix}@example.com`;
    cleanupEmails.push(email);

    const result = await signup(
      {},
      formData({
        firstName: "A".repeat(101),
        lastName: "Signup",
        phone: "88883333",
        email,
        homeAcademySlug: "escazu",
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "a-sufficiently-long-password",
      }),
    );

    expect(result.ok).toBeUndefined();
    expect(result.error).toBe("invalid");
    expect(result.fieldErrors?.firstName).toBeDefined();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});
