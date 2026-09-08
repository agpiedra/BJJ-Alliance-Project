import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { signup } from "../../src/app/[locale]/signup/actions";

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

describe("signup — a staff-created student who later self-signs-up is LINKED, never duplicated", () => {
  afterAll(async () => {
    const students = await prisma.student.findMany({
      where: { email: { in: cleanupEmails } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: students.map((s) => s.id) } } });
    await prisma.student.deleteMany({ where: { email: { in: cleanupEmails } } });
    await prisma.user.deleteMany({ where: { email: { in: cleanupEmails } } });
  });

  it("claims the existing userId-less row, keeps staff's codeHash/belt/academy, and creates exactly one Student", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
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

    // The same person now self-registers — deliberately submitting DIFFERENT
    // (and lower) belt/stripes and the OTHER academy, exactly what a naive
    // create-both-rows path would have written over staff's data.
    const result = await signup(
      {},
      formData({
        firstName: "SelfSignup",
        lastName: "Claimed",
        phone: "88886666",
        email,
        homeAcademySlug: "escazu",
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "a-sufficiently-long-password",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.linked).toBe(true);
    // No new code is issued on the link path — the staff-issued one still works.
    expect(result.code).toBeUndefined();

    // (a) exactly ONE Student row at this email, not two
    const students = await prisma.student.findMany({ where: { email } });
    expect(students).toHaveLength(1);
    const linked = students[0];
    expect(linked.id).toBe(staffCreated.id);

    // (b) it now carries the new user's id
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe("STUDENT");
    expect(linked.userId).toBe(user.id);

    // (c) everything staff owned is byte-for-byte unchanged — the signup
    //     form's WHITE / 0 stripes / Escazú values were discarded, not applied
    expect(linked.codeHash).toBe(staffCodeHash);
    expect(linked.currentBelt).toBe("PURPLE");
    expect(linked.currentStripes).toBe(3);
    expect(linked.homeAcademyId).toBe(escalante.id);
    expect(linked.homeAcademyId).not.toBe(escazu.id);
    expect(linked.status).toBe("ACTIVE");
    expect(linked.firstName).toBe("StaffEntered");

    // The link is audited, attributed to the student's own brand-new user id
    // (this is a self-service event — there is no staff actor).
    const audits = await prisma.auditLog.findMany({
      where: { entityId: linked.id, action: "student.linkedSelfSignup" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe("Student");
    expect(audits[0].actorId).toBe(user.id);
    expect(audits[0].academyId).toBe(escalante.id);
    expect(JSON.stringify(audits[0].after)).not.toContain(staffCodeHash);
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
    expect(result.linked).toBeUndefined();
    expect(result.code).toMatch(/^\d{4}$/);

    const students = await prisma.student.findMany({ where: { email } });
    expect(students).toHaveLength(1);
    expect(students[0].status).toBe("PENDING");
    expect(students[0].userId).not.toBeNull();
    expect(students[0].codeHash).toBe(digestLookupSecret(result.code!, pepper));
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
    const second = await signup({}, formData(base));
    expect(second.error).toBe("emailTaken");
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });
});
