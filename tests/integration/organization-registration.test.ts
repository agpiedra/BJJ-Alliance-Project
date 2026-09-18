import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real Resend credentials in this dev/test environment — mocked the same
// way this codebase already mocks other external services (Supabase in
// branding-actions.test.ts). What's under test here is registerOrganization's
// own transaction/rate-limit/honeypot logic, not real email delivery.
const sendTransactionalEmailMock = vi.fn(async (_to: string, _subject: string, _bodyLines: string[]) => ({ success: true }));
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: (...args: [string, string, string[]]) => sendTransactionalEmailMock(...args),
}));

const { registerOrganization, checkSlugAvailability } = await import(
  "../../src/app/[locale]/register-academy/actions"
);

const prisma = getTestPrismaClient();

const cleanupOrgIds: string[] = [];

async function cleanup() {
  if (cleanupOrgIds.length === 0) return;
  await prisma.beltRank.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function registrationFormData(overrides: Record<string, string> = {}): FormData {
  const suffix = uniqueSuffix();
  const fd = new FormData();
  const defaults: Record<string, string> = {
    organizationName: `Test Academy ${suffix}`,
    desiredSlug: `test-academy-${suffix}`,
    country: "Costa Rica",
    city: "San José",
    contactName: "Test Director",
    contactEmail: `director-${suffix}@example.com`,
    contactPhone: "88880000",
    studentCountBand: "1-25",
    preferredLocale: "es",
    termsAccepted: "on",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    fd.set(key, value);
  }
  return fd;
}

describe("registerOrganization", () => {
  afterAll(cleanup);
  afterEach(() => sendTransactionalEmailMock.mockClear());

  // resolveClientIp() falls back to a shared "unknown" bucket outside a real
  // Next.js request (which every call in this file is) — see that
  // function's own doc comment. Without this, every test's registration
  // attempts would pile into the SAME ip="unknown" rate-limit bucket and
  // pollute each other's counts. "unknown" is a value only these tests ever
  // produce in this environment, so clearing it between tests is safe and
  // test-local, never touching a real IP's real counter.
  beforeEach(async () => {
    await prisma.registrationAttempt.deleteMany({ where: { ip: "unknown" } });
  });

  it("creates a PENDING organization with all fields persisted, branding defaults, and both seeded rank catalogs, in one transaction", async () => {
    const fd = registrationFormData();
    const result = await registerOrganization({}, fd);
    expect(result.ok).toBe(true);

    const slug = fd.get("desiredSlug") as string;
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
    cleanupOrgIds.push(org.id);

    expect(org.status).toBe("PENDING");
    expect(org.country).toBe("Costa Rica");
    expect(org.city).toBe("San José");
    expect(org.contactEmail).toBe(fd.get("contactEmail"));
    expect(org.studentCountBand).toBe("1-25");
    expect(org.termsAcceptedAt).not.toBeNull();
    expect(org.termsVersion).not.toBeNull();

    const branding = await prisma.organizationBranding.findUnique({ where: { organizationId: org.id } });
    expect(branding).not.toBeNull();

    const beltRankCount = await prisma.beltRank.count({ where: { organizationId: org.id } });
    expect(beltRankCount).toBe(18); // 5 ADULT + 13 KIDS, same catalog Alliance's own seed uses

    const promotionConfigCount = await prisma.promotionConfig.count({ where: { organizationId: org.id } });
    expect(promotionConfigCount).toBe(2); // ADULT + KIDS

    // Sent AFTER the transaction, per the doc's own "email failure does not
    // roll back signup" — asserting it was called at all, not its content.
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });

  it("a simulated email failure still leaves the registration committed (doc: 'send email after the transaction; email failure does not roll back signup')", async () => {
    sendTransactionalEmailMock.mockImplementationOnce(async () => ({ success: false, error: "simulated failure" }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fd = registrationFormData();
    const slug = fd.get("desiredSlug") as string;
    const result = await registerOrganization({}, fd);

    expect(result.ok).toBe(true); // the action itself still reports success
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
    cleanupOrgIds.push(org.id);
    expect(org.status).toBe("PENDING");
    expect(consoleErrorSpy).toHaveBeenCalled(); // failure logged loudly, never silently swallowed

    consoleErrorSpy.mockRestore();
  });

  it("honeypot: silent success, nothing written", async () => {
    const fd = registrationFormData({ website: "http://spam.example.com" });
    const slug = fd.get("desiredSlug") as string;

    const result = await registerOrganization({}, fd);
    expect(result.ok).toBe(true);

    expect(await prisma.organization.findUnique({ where: { slug } })).toBeNull();
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  it("duplicate slug is refused gracefully, not a 500", async () => {
    const first = registrationFormData();
    const slug = first.get("desiredSlug") as string;
    const firstResult = await registerOrganization({}, first);
    expect(firstResult.ok).toBe(true);
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
    cleanupOrgIds.push(org.id);

    const second = registrationFormData({ desiredSlug: slug, contactEmail: `other-${uniqueSuffix()}@example.com` });
    const secondResult = await registerOrganization({}, second);
    expect(secondResult.error).toBe("slugTaken");
    expect(secondResult.slugTaken).toBe(true);
  });

  it("duplicate contact email (already PENDING) is refused gracefully", async () => {
    const first = registrationFormData();
    const email = first.get("contactEmail") as string;
    const firstResult = await registerOrganization({}, first);
    expect(firstResult.ok).toBe(true);
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: first.get("desiredSlug") as string } });
    cleanupOrgIds.push(org.id);

    const second = registrationFormData({ contactEmail: email });
    const secondResult = await registerOrganization({}, second);
    expect(secondResult.error).toBe("emailAlreadyRegistered");
  });

  it("rate limits after 3 attempts from the same email within the window", async () => {
    const email = `rate-limit-${uniqueSuffix()}@example.com`;
    for (let i = 0; i < 3; i++) {
      await registerOrganization({}, registrationFormData({ contactEmail: email }));
    }
    const fourth = await registerOrganization({}, registrationFormData({ contactEmail: email }));
    expect(fourth.error).toBe("rateLimited");
  });

  it("checkSlugAvailability reflects real uniqueness, never the final authority", async () => {
    const fd = registrationFormData();
    const slug = fd.get("desiredSlug") as string;

    expect((await checkSlugAvailability(slug)).available).toBe(true);

    const result = await registerOrganization({}, fd);
    expect(result.ok).toBe(true);
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
    cleanupOrgIds.push(org.id);

    expect((await checkSlugAvailability(slug)).available).toBe(false);
  });
});
