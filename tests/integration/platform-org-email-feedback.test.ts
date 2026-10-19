import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { hashSecret } from "../../src/lib/crypto";
import type { EmailSendOutcome } from "../../src/lib/email/send-transactional-email";

/**
 * The platform's Approve and New organization actions report the organization operation's success SEPARATELY from
 * the owner's invitation email outcome and what settlement found — through the real action boundaries
 * (`approveOrganizationAction`, `createOrganizationManually`) on the isolated test database. The email helper is
 * mocked to return each classified outcome (or held, so the test decides when settlement runs); a settlement failure
 * comes from wrapping this file's import of `@/lib/prisma` (test-only), never from code in src/.
 */
const sendMock = vi.fn();
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: (...args: unknown[]) => sendMock(...args),
}));

let currentSession: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  // signIn() carries out its own redirect, so a real accept of a new account ends in a NEXT_REDIRECT throw.
  signIn: (_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  },
}));

/** Scripted `$transaction` failures for the app's client: each entry is consumed by one call, "fail" rejects it. */
const transactionScript: Array<"pass" | "fail"> = [];
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/prisma")>();
  const prisma = new Proxy(real.prisma, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (...args: unknown[]) => {
          if (transactionScript.shift() === "fail") return Promise.reject(new Error("synthetic transaction failure"));
          return (target.$transaction as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...real, prisma };
});

const { approveOrganizationAction } = await import("../../src/app/[locale]/platform/organizations/actions");
const { createOrganizationManually } = await import("../../src/app/[locale]/platform/organizations/new/actions");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { invitationFeedbackCopy } = await import("../../src/lib/organizations/invitation-feedback");
const { default: enMessages } = await import("../../messages/en.json");
const { default: esMessages } = await import("../../messages/es.json");

const prisma = getTestPrismaClient();
const orgIds: string[] = [];
const emails: string[] = [];
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let counter = 0;

const sendResult = (outcome: EmailSendOutcome) => ({ success: outcome === "accepted", outcome });
const respondWith = (outcome: EmailSendOutcome) => sendMock.mockImplementation(async () => sendResult(outcome));
function holdSends(): Array<(outcome: EmailSendOutcome) => void> {
  const releases: Array<(outcome: EmailSendOutcome) => void> = [];
  sendMock.mockImplementation(() => new Promise((resolve) => releases.push((outcome) => resolve(sendResult(outcome)))));
  return releases;
}
const untilSends = (releases: unknown[], n: number) => vi.waitFor(() => expect(releases).toHaveLength(n), { timeout: 10_000, interval: 10 });
const sentToken = (i: number) => (sendMock.mock.calls[i][2] as string[]).join("\n").match(/accept-invitation\?token=([A-Za-z0-9_-]+)/)![1];
const invitationsOf = (organizationId: string) => prisma.invitation.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });

async function superAdmin() {
  const email = `feedback-super-${++counter}-${suffix}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN", isSuperAdmin: true } });
  currentSession = { user: { id: user.id } };
}

async function pendingOrganization() {
  counter += 1;
  const contactEmail = `feedback-owner-${counter}-${suffix}@example.test`;
  emails.push(contactEmail);
  const org = await prisma.organization.create({
    data: { slug: `feedback-${suffix}-${counter}`, name: `Feedback ${counter}`, status: "PENDING", city: "Heredia", country: "Costa Rica", contactEmail },
  });
  orgIds.push(org.id);
  return org;
}

function creationForm(label: string) {
  counter += 1;
  const fd = new FormData();
  const fields = {
    organizationName: `Feedback Manual ${label} ${counter}`,
    desiredSlug: `feedback-manual-${label}-${suffix}-${counter}`,
    country: "Costa Rica",
    city: "Heredia",
    directorEmail: `feedback-manual-${label}-${counter}-${suffix}@example.test`,
    contactName: "Feedback Owner",
    contactPhone: "88880000",
    studentCountBand: "1-25",
    preferredLocale: "en",
    promotionMode: "ATTENDANCE",
  };
  emails.push(fields.directorEmail);
  for (const [name, value] of Object.entries(fields)) fd.set(name, value);
  return { fd, slug: fields.desiredSlug };
}

async function create(label: string) {
  const { fd, slug } = creationForm(label);
  const result = await createOrganizationManually({}, fd);
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (org) orgIds.push(org.id);
  return { result, org };
}

beforeEach(async () => {
  transactionScript.length = 0;
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {}); // revalidation outside a request logs; not under test here
  await superAdmin();
});

afterEach(() => {
  vi.restoreAllMocks();
  currentSession = null;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users.map((user) => user.id) } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("Approve: the approval is reported separately from the email outcome", () => {
  for (const outcome of ["accepted", "rejected", "not_configured", "unknown"] as const) {
    it(`REQUIRED ${outcome}: approved (ACTIVE, academy, owner membership) — the outcome is reported beside ok, never as an error`, async () => {
      const org = await pendingOrganization();
      respondWith(outcome);

      const result = await approveOrganizationAction(org.id);

      expect(result).toEqual({ ok: true, invitationEmail: outcome, invitationSettlement: "settled" });
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("ACTIVE");
      expect(await prisma.academy.count({ where: { organizationId: org.id } })).toBe(1);
      expect(await prisma.organizationMembership.count({ where: { organizationId: org.id, role: "ADMIN" } })).toBe(1);
      const [invitation] = await invitationsOf(org.id);
      // The existing platform policy: a provably undelivered first link is withdrawn; accepted / unknown stay open.
      expect(invitation.revokedAt !== null).toBe(outcome === "rejected" || outcome === "not_configured");
    });
  }

  it("REQUIRED settlement 'unavailable' (the new link revoked while its email was in flight) is reported; still approved", async () => {
    const org = await pendingOrganization();
    const releases = holdSends();
    const pending = approveOrganizationAction(org.id);
    await untilSends(releases, 1);
    await prisma.invitation.updateMany({ where: { organizationId: org.id }, data: { revokedAt: new Date() } });
    releases[0]("accepted");

    expect(await pending).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "unavailable" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("ACTIVE");
  });

  it("REQUIRED settlement 'acceptedMeanwhile' (the owner accepted before settlement) is reported; still approved", async () => {
    const org = await pendingOrganization();
    const releases = holdSends();
    const pending = approveOrganizationAction(org.id);
    await untilSends(releases, 1);
    const fd = new FormData();
    fd.set("token", sentToken(0));
    fd.set("password", "Feedback-owner-password-1");
    await expect(acceptInvitation("en", {}, fd)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    releases[0]("accepted");

    expect(await pending).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "acceptedMeanwhile" });
  });

  it("REQUIRED settlement 'failed' is reported; still approved, and the issued invitation is left as it was", async () => {
    const org = await pendingOrganization();
    const releases = holdSends();
    const pending = approveOrganizationAction(org.id);
    await untilSends(releases, 1);
    transactionScript.push("fail"); // the next $transaction is settlement's
    releases[0]("rejected");

    expect(await pending).toEqual({ ok: true, invitationEmail: "rejected", invitationSettlement: "failed" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("ACTIVE");
    const [invitation] = await invitationsOf(org.id);
    expect(invitation.revokedAt).toBeNull(); // settlement never ran
  });

  it("existing failure handling is intact: not approvable → error; non-super-admin → notFound, untouched", async () => {
    const cancelled = await pendingOrganization();
    await prisma.organization.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    expect(await approveOrganizationAction(cancelled.id)).toEqual({ error: "notApprovable" });
    expect(await approveOrganizationAction("no-such-organization")).toEqual({ error: "notFound" });

    const org = await pendingOrganization();
    const email = `feedback-plain-${suffix}@example.test`;
    emails.push(email);
    const plain = await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN" } });
    currentSession = { user: { id: plain.id } };
    expect(await approveOrganizationAction(org.id)).toEqual({ error: "notFound" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("PENDING");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("correction: a withdrawn link says nothing about other invitations", () => {
  it("REQUIRED a rejected first send withdraws only ITS link; a concurrent second invitation to the same recipient stays valid — and the first report's wording claims nothing about all invitations", async () => {
    const org = await pendingOrganization();
    const releases = holdSends();
    const first = approveOrganizationAction(org.id); // approves, issues N1, its email held
    await untilSends(releases, 1);
    const second = approveOrganizationAction(org.id); // already ACTIVE: issues N2 to the same recipient, its email held
    await untilSends(releases, 2);
    const [n1, n2] = await invitationsOf(org.id);
    expect(n2.email).toBe(n1.email);

    releases[0]("rejected");
    const firstReport = await first;
    expect(firstReport).toEqual({ ok: true, invitationEmail: "rejected", invitationSettlement: "settled" });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: n1.id } })).revokedAt).not.toBeNull(); // N1 withdrawn
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: n2.id } })).toMatchObject({ usedAt: null, revokedAt: null }); // N2 untouched

    releases[1]("accepted");
    expect(await second).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "settled" });
    // N2 is genuinely valid: its link is accepted for real.
    const fd = new FormData();
    fd.set("token", sentToken(1));
    fd.set("password", "Feedback-owner-password-1");
    await expect(acceptInvitation("en", {}, fd)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: n2.id } })).acceptedAt).not.toBeNull();

    // The first report's copy states only what happened to ITS link.
    const copy = invitationFeedbackCopy(firstReport);
    expect(copy.settlement).toBe("settlement.withdrawn");
    for (const messages of [enMessages, esMessages]) {
      const text = `${messages.platform.organizations.invitationFeedback.email.rejected} ${messages.platform.organizations.invitationFeedback.settlement.withdrawn}`;
      expect(text).not.toMatch(/no working invitation|has no working|no (?:tiene|hay) (?:una )?invitación que funcione/i);
    }
    expect(enMessages.platform.organizations.invitationFeedback.settlement.withdrawn).toMatch(/^This invitation link was withdrawn\./);
    expect(esMessages.platform.organizations.invitationFeedback.settlement.withdrawn).toMatch(/^Este enlace de invitación se retiró\./);
  });
});

describe("New organization: creation is reported separately from the email outcome", () => {
  for (const outcome of ["accepted", "rejected", "not_configured", "unknown"] as const) {
    it(`REQUIRED ${outcome}: created (ACTIVE, ranks, academy) — the result carries its id and the outcome beside ok`, async () => {
      respondWith(outcome);

      const { result, org } = await create(outcome.replace("_", "-"));

      expect(org).not.toBeNull();
      expect(result).toEqual({ ok: true, organizationId: org!.id, invitationEmail: outcome, invitationSettlement: "settled" });
      expect(org!.status).toBe("ACTIVE");
      expect(await prisma.beltRank.count({ where: { organizationId: org!.id } })).toBe(18);
      expect(await prisma.academy.count({ where: { organizationId: org!.id } })).toBe(1);
    });
  }

  it("REQUIRED settlement 'unavailable' is reported; the organization is created", async () => {
    const releases = holdSends();
    const { fd, slug } = creationForm("unavailable");
    const pending = createOrganizationManually({}, fd);
    await untilSends(releases, 1);
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
    orgIds.push(org.id);
    await prisma.invitation.updateMany({ where: { organizationId: org.id }, data: { revokedAt: new Date() } });
    releases[0]("unknown");

    expect(await pending).toEqual({ ok: true, organizationId: org.id, invitationEmail: "unknown", invitationSettlement: "unavailable" });
  });

  it("existing failure handling is intact: invalid form and taken slug create nothing and report no email; non-super-admin → notFound", async () => {
    respondWith("accepted");
    const { fd, slug } = creationForm("invalid");
    fd.set("logo", "unexpected-field");
    expect(await createOrganizationManually({}, fd)).toMatchObject({ error: "invalid" });
    expect(await prisma.organization.findUnique({ where: { slug } })).toBeNull();

    const first = await create("taken");
    expect(first.result.ok).toBe(true);
    const again = creationForm("taken-again");
    again.fd.set("desiredSlug", first.org!.slug);
    const taken = await createOrganizationManually({}, again.fd);
    expect(taken).toMatchObject({ error: "slugTaken", slugTaken: true });
    expect(taken).not.toHaveProperty("invitationEmail");

    sendMock.mockClear();
    const email = `feedback-plain-2-${suffix}@example.test`;
    emails.push(email);
    const plain = await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN" } });
    currentSession = { user: { id: plain.id } };
    const denied = creationForm("denied");
    expect(await createOrganizationManually({}, denied.fd)).toEqual({ error: "notFound" });
    expect(await prisma.organization.findUnique({ where: { slug: denied.slug } })).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
