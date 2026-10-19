import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { digestLookupSecret, generateRandomToken, hashSecret } from "../../src/lib/crypto";
import type { EmailSendOutcome } from "../../src/lib/email/send-transactional-email";

/**
 * docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md — the owner invitation lifecycle under every send outcome, every race the
 * plan lists, expiry while waiting, and transaction failures. Real Postgres throughout (the isolated test database).
 *
 * Determinism, with no production test hook:
 * - provider responses are HELD (the email helper is mocked to return a promise the test resolves), so the test decides
 *   when settlement runs;
 * - orderings under the lock use a HELD LOCK: the test takes the organization's own advisory lock in its own
 *   transaction, starts the operations, waits until `pg_locks` shows each one queued behind it, then commits. Postgres
 *   grants queued exclusive advisory-lock requests in arrival order, so the queue order is the execution order;
 * - expiry while waiting fakes `Date` only (no timers), so Postgres I/O stays real;
 * - transaction failures come from wrapping this file's import of `@/lib/prisma` (test-only module mock), never from
 *   code in src/.
 */

const sendMock = vi.fn();
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: (...args: unknown[]) => sendMock(...args),
}));

// signIn() carries out its own redirect, so a real accept of a new account ends in a NEXT_REDIRECT throw.
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(null),
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

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { revokeStaffInvitation } = await import("../../src/lib/staff/staff-service");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { reportOwnerResendBlockers } = await import("../../src/lib/organizations/legacy-invitation-report");

const prisma = getTestPrismaClient();
const orgIds: string[] = [];
const emails: string[] = [];
let approverId = "";
let consoleCalls: unknown[][] = [];

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const sendResult = (outcome: EmailSendOutcome) => ({ success: outcome === "accepted", outcome });
const respondWith = (outcome: EmailSendOutcome) => sendMock.mockImplementation(async () => sendResult(outcome));

/** Every send from now on waits; `releases[i](outcome)` answers the i-th one. */
function holdSends(): Array<(outcome: EmailSendOutcome) => void> {
  const releases: Array<(outcome: EmailSendOutcome) => void> = [];
  sendMock.mockImplementation(() => new Promise((resolve) => releases.push((outcome) => resolve(sendResult(outcome)))));
  return releases;
}

const tokenOf = (link: string | null) => new URL(link!).searchParams.get("token")!;
const idOfToken = async (token: string) =>
  (await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: digestLookupSecret(token, process.env.CODE_PEPPER!) } })).id;
const row = (id: string) => prisma.invitation.findUniqueOrThrow({ where: { id }, select: { usedAt: true, acceptedAt: true, revokedAt: true } });
const liveIds = async (organizationId: string) =>
  (await prisma.invitation.findMany({ where: { organizationId, usedAt: null, revokedAt: null }, orderBy: { createdAt: "asc" } })).map((r) => r.id);

/** An ACTIVE organization approved for real (email accepted): its owner's first invitation is O. */
async function approvedOrganization() {
  const suffix = uniqueSuffix();
  const contactEmail = `lifecycle-owner-${suffix}@example.test`;
  emails.push(contactEmail);
  const org = await prisma.organization.create({
    data: { slug: `lifecycle-${suffix}`, name: `Lifecycle ${suffix}`, status: "PENDING", city: "Test City", country: "Costa Rica", contactEmail },
  });
  orgIds.push(org.id);
  respondWith("accepted");
  const first = await approveOrganization(org.slug, approverId);
  expect(first.invitationSettlement).toBe("settled");
  const oToken = tokenOf(first.invitationLink);
  sendMock.mockClear(); // a test's send-count assertions start after the fixture's own send
  return { org, contactEmail, oToken, oId: await idOfToken(oToken) };
}

/** A second, active Owner of the organization — the one who can withdraw invitations on the staff page. */
async function coOwnerContext(organizationId: string) {
  const email = `lifecycle-coowner-${uniqueSuffix()}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN", active: true } });
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role: "ADMIN", active: true } });
  return requireOrganizationAccess(user.id, organizationId);
}

/** Accepts like a request does. "accepted" = committed (redirected into a session, or ok for an existing account). */
async function accept(token: string): Promise<string> {
  const fd = new FormData();
  fd.set("token", token);
  fd.set("password", "Lifecycle-owner-password-1");
  try {
    const result = await acceptInvitation("en", {}, fd);
    return result.ok ? "accepted" : (result.error ?? "none");
  } catch (error) {
    if ((error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) return "accepted";
    throw error;
  }
}

/**
 * Queued (not granted) advisory-lock requests in THIS database. fileParallelism is off for integration tests and nothing
 * else in this file takes advisory locks, so every waiter is one of ours — and other databases on the same server (a
 * disposable browser-check database, say) are excluded.
 */
async function lockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0].n;
}
const untilWaiting = (n: number) => vi.waitFor(async () => expect(await lockWaiters()).toBe(n), { timeout: 10_000, interval: 20 });

/** Takes the organization's invitation lock (the same key as lockOrganizationStaff) and runs `body` while holding it. */
async function holdingLock(organizationId: string, body: () => Promise<void>) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))::text AS locked`;
      await body();
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
}

beforeAll(async () => {
  const email = `lifecycle-approver-${uniqueSuffix()}@example.test`;
  emails.push(email);
  approverId = (await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN", isSuperAdmin: true } })).id;
});

beforeEach(() => {
  consoleCalls = [];
  transactionScript.length = 0;
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleCalls.push(args);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("lifecycle by outcome", () => {
  it("CLI fallback: a rejected or unconfigured send keeps the new link live and leaves the earlier one; accepting the new one retires it", async () => {
    for (const outcome of ["rejected", "not_configured"] as const) {
      const { org, oId } = await approvedOrganization();
      respondWith(outcome);
      const resend = await approveOrganization(org.slug, approverId, { keepLinkOnFailedSend: true });
      expect(resend).toMatchObject({ invitationIssue: "issued", invitationEmailOutcome: outcome, invitationSettlement: "settled" });
      const nId = await idOfToken(tokenOf(resend.invitationLink));
      expect(await liveIds(org.id)).toEqual([oId, nId]);

      expect(await accept(tokenOf(resend.invitationLink))).toBe("accepted");
      expect((await row(oId)).revokedAt).not.toBeNull();
    }
  });

  it("unknown: both links stay; whichever is accepted first retires the other, which is then refused", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    respondWith("unknown");
    const resend = await approveOrganization(org.slug, approverId);
    expect(resend).toMatchObject({ invitationEmailOutcome: "unknown", invitationSettlement: "settled" });
    const nToken = tokenOf(resend.invitationLink);
    const nId = await idOfToken(nToken);
    expect(await liveIds(org.id)).toEqual([oId, nId]);

    expect(await accept(nToken)).toBe("accepted");
    expect(await row(nId)).toMatchObject({ usedAt: expect.any(Date), acceptedAt: expect.any(Date), revokedAt: null });
    expect(await row(oId)).toMatchObject({ usedAt: null, acceptedAt: null, revokedAt: expect.any(Date) });
    expect(await accept(oToken)).toBe("invalidToken");
  });

  it("genuine acceptance records acceptedAt (= usedAt) and then blocks issuing: 'alreadyAccepted', nothing sent", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    expect(await accept(oToken)).toBe("accepted");
    const accepted = await row(oId);
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.acceptedAt).toEqual(accepted.usedAt);

    respondWith("accepted");
    const again = await approveOrganization(org.slug, approverId);
    expect(again).toMatchObject({ invitationIssue: "alreadyAccepted", invitationLink: null, invitationEmailOutcome: null, invitationSettlement: null });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("an expired, unaccepted invitation never blocks a resend", async () => {
    const { org, oId } = await approvedOrganization();
    await prisma.invitation.update({ where: { id: oId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "issued", invitationSettlement: "settled" });
  });

  it("a legacy-used row (usedAt, no acceptedAt, not revoked) blocks with 'legacyUnresolved', unchanged; another live invitation still accepts normally", async () => {
    const { org, contactEmail, oToken, oId } = await approvedOrganization();
    const legacy = await prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(generateRandomToken(), process.env.CODE_PEPPER!),
        email: contactEmail,
        organizationId: org.id,
        role: "ADMIN",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedAt: new Date(Date.now() - 60_000),
      },
    });
    const before = await prisma.invitation.findUniqueOrThrow({ where: { id: legacy.id } });

    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "legacyUnresolved", invitationLink: null });
    expect(sendMock).not.toHaveBeenCalled();
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(before);

    expect(await accept(oToken)).toBe("accepted");
    expect((await row(oId)).acceptedAt).not.toBeNull();
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(before);
  });

  it("a row both used and revoked was never accepted and is not legacy: it neither blocks nor counts as accepted", async () => {
    const { org, contactEmail } = await approvedOrganization();
    await prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(generateRandomToken(), process.env.CODE_PEPPER!),
        email: contactEmail,
        organizationId: org.id,
        role: "ADMIN",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedAt: new Date(),
        revokedAt: new Date(),
      },
    });
    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "issued", invitationSettlement: "settled" });
  });

  it("organization scope: settlement and acceptance never touch another organization's invitation to the same address", async () => {
    const { org, contactEmail, oToken } = await approvedOrganization();
    const other = await approvedOrganization();
    const foreign = await prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(generateRandomToken(), process.env.CODE_PEPPER!),
        email: contactEmail.toUpperCase(),
        organizationId: other.org.id,
        role: "ADMIN",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    respondWith("accepted");
    await approveOrganization(org.slug, approverId);
    respondWith("unknown");
    const unknown = await approveOrganization(org.slug, approverId);
    expect(await accept(tokenOf(unknown.invitationLink))).toBe("accepted");
    expect(await accept(oToken)).toBe("invalidToken");

    expect(await row(foreign.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
  });
});

describe("address scope — an invitation's recipient is its exact stored address, the same identity acceptance resolves", () => {
  /**
   * `User.email` is unique case-SENSITIVELY and acceptance resolves the account with an exact lookup, so two addresses
   * that differ only by case can be two distinct accounts. Lifecycle matching must never let one interfere with the other.
   */
  async function caseVariantAccount(contactEmail: string) {
    const email = contactEmail.toUpperCase();
    emails.push(email);
    const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("variant-password-1"), role: "ADMIN", active: true } });
    return { user, email };
  }
  async function invitationFor(organizationId: string, email: string, extra: { usedAt?: Date } = {}) {
    const token = generateRandomToken();
    const row = await prisma.invitation.create({
      data: { tokenHash: digestLookupSecret(token, process.env.CODE_PEPPER!), email, organizationId, role: "ADMIN", expiresAt: new Date(Date.now() + 86_400_000), ...extra },
    });
    return { token, id: row.id };
  }

  it("two distinct case-variant accounts: accepting one's invitation neither revokes the other's nor blocks the other's resend", async () => {
    const { org, contactEmail, oToken, oId } = await approvedOrganization();
    const variant = await caseVariantAccount(contactEmail);
    expect(variant.user.id).not.toBe((await prisma.user.findUniqueOrThrow({ where: { email: contactEmail } })).id);
    const theirs = await invitationFor(org.id, variant.email);

    expect(await accept(theirs.token)).toBe("accepted");
    expect(await row(oId)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null }); // the owner's link is untouched

    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "issued", invitationSettlement: "settled" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await accept(oToken)).toBe("invalidToken"); // retired by the owner's own accepted resend — not by the variant
  });

  it("two distinct case-variant accounts: an owner resend's settlement never retires the other account's live invitation", async () => {
    const { org, contactEmail, oId } = await approvedOrganization();
    const variant = await caseVariantAccount(contactEmail);
    const theirs = await invitationFor(org.id, variant.email);

    respondWith("accepted");
    const resend = await approveOrganization(org.slug, approverId);
    expect(resend.invitationSettlement).toBe("settled");

    expect((await row(oId)).revokedAt).not.toBeNull();
    expect(await row(theirs.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
    expect(await accept(theirs.token)).toBe("accepted");
  });

  it("two distinct case-variant accounts: the other account's legacy-used or accepted row neither blocks nor short-circuits the owner's resend", async () => {
    const { org, contactEmail } = await approvedOrganization();
    const variant = await caseVariantAccount(contactEmail);
    await invitationFor(org.id, variant.email, { usedAt: new Date(Date.now() - 60_000) }); // legacy-used, other account

    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "issued", invitationSettlement: "settled" });
  });

  it("the same recipient (identical stored address): repeated invitations still supersede, and one acceptance retires all the others", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    respondWith("unknown");
    const first = await approveOrganization(org.slug, approverId);
    const second = await approveOrganization(org.slug, approverId);
    const ids = [oId, await idOfToken(tokenOf(first.invitationLink)), await idOfToken(tokenOf(second.invitationLink))];
    expect(await liveIds(org.id)).toEqual(ids);

    expect(await accept(oToken)).toBe("accepted");
    expect(await liveIds(org.id)).toEqual([]);
    for (const id of ids.slice(1)) expect((await row(id)).revokedAt).not.toBeNull();
    respondWith("accepted");
    expect(await approveOrganization(org.slug, approverId)).toMatchObject({ invitationIssue: "alreadyAccepted" });
  });
});

describe("orderings — accepted settlement vs acceptance of the old link (S1)", () => {
  it("acceptance wins: the old link is accepted, the new one revoked with it; settlement reports 'acceptedMeanwhile' and changes nothing", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    expect(await accept(oToken)).toBe("accepted");
    releases[0]("accepted");
    const result = await resend;

    expect(result.invitationSettlement).toBe("acceptedMeanwhile");
    expect(await row(oId)).toMatchObject({ acceptedAt: expect.any(Date), revokedAt: null });
    expect((await row(await idOfToken(tokenOf(result.invitationLink)))).revokedAt).not.toBeNull();
    expect(await liveIds(org.id)).toEqual([]);
  });

  it("settlement wins: the old link is retired and its later acceptance refused; the new link stays live, nothing accepted", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    respondWith("accepted");
    const result = await approveOrganization(org.slug, approverId);
    expect(result.invitationSettlement).toBe("settled");

    expect(await accept(oToken)).toBe("invalidToken");
    expect(await row(oId)).toMatchObject({ usedAt: null, acceptedAt: null, revokedAt: expect.any(Date) });
    expect(await liveIds(org.id)).toEqual([await idOfToken(tokenOf(result.invitationLink))]);
    expect(await prisma.invitation.count({ where: { organizationId: org.id, acceptedAt: { not: null } } })).toBe(0);
  });

  it("stale pre-check: acceptance read the old link as live, settlement commits first under the lock — the consume re-checks and refuses; nothing written", async () => {
    const { org, contactEmail, oToken, oId } = await approvedOrganization();
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: contactEmail } });
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    let acceptance!: Promise<string>;
    await holdingLock(org.id, async () => {
      releases[0]("accepted");
      await untilWaiting(1); // settlement queued first
      acceptance = accept(oToken); // its pre-check runs now, while O is still live
      await untilWaiting(2); // then acceptance queued behind it
    });

    expect((await resend).invitationSettlement).toBe("settled");
    expect(await acceptance).toBe("invalidToken");
    expect(await row(oId)).toMatchObject({ usedAt: null, acceptedAt: null, revokedAt: expect.any(Date) });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ active: false, passwordHash: owner.passwordHash });
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "staff.accept" } })).toBe(0);
  });
});

describe("orderings — withdrawal of a rejected new link vs acceptance of that link (S2)", () => {
  it("acceptance wins: the new link is accepted and the old one retired; settlement reports 'acceptedMeanwhile'", async () => {
    const { org, oId } = await approvedOrganization();
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const nId = (await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id, id: { not: oId } } })).id;
    // The link escaped (as the CLI would print it): read its token from the held send's own arguments.
    const lines = sendMock.mock.calls[0][2] as string[];
    const nToken = tokenOf(lines.find((line) => line.includes("accept-invitation"))!);

    expect(await accept(nToken)).toBe("accepted");
    releases[0]("rejected");

    expect((await resend).invitationSettlement).toBe("acceptedMeanwhile");
    expect(await row(nId)).toMatchObject({ acceptedAt: expect.any(Date), revokedAt: null });
    expect((await row(oId)).revokedAt).not.toBeNull();
  });

  it("settlement wins: the new link is withdrawn and its acceptance refused; the old link is untouched", async () => {
    const { org, oId } = await approvedOrganization();
    respondWith("rejected");
    const result = await approveOrganization(org.slug, approverId);
    expect(result.invitationSettlement).toBe("settled");

    expect(await accept(tokenOf(result.invitationLink))).toBe("invalidToken");
    expect(await liveIds(org.id)).toEqual([oId]);
  });
});

describe("other races", () => {
  it("R1: a delayed settlement never retires a NEWER invitation; it reports 'unavailable' for its own superseded link, claiming no cause", async () => {
    const { org, oId } = await approvedOrganization();
    const releases = holdSends();
    const resendA = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const resendB = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[1]("accepted");
    const b = await resendB;
    releases[0]("accepted");
    const a = await resendA;

    const nA = await idOfToken(tokenOf(a.invitationLink));
    const nB = await idOfToken(tokenOf(b.invitationLink));
    expect(b.invitationSettlement).toBe("settled");
    expect(a.invitationSettlement).toBe("unavailable");
    expect(await liveIds(org.id)).toEqual([nB]);
    expect((await row(nA)).revokedAt).not.toBeNull();
    expect((await row(oId)).revokedAt).not.toBeNull();
  });

  it("R1, other order: the OLDER resend settles first — it retires only what it captured, never the newer invitation issued after it", async () => {
    const { org, oId } = await approvedOrganization();
    const releases = holdSends();
    const resendA = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const resendB = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[0]("accepted");
    const a = await resendA;
    const nA = await idOfToken(tokenOf(a.invitationLink));
    const nBId = (await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id, id: { notIn: [oId, nA] } } })).id;
    expect(a.invitationSettlement).toBe("settled");
    expect(await liveIds(org.id)).toEqual([nA, nBId]); // O retired; B's newer link untouched

    releases[1]("accepted");
    expect((await resendB).invitationSettlement).toBe("settled");
    expect(await liveIds(org.id)).toEqual([nBId]);
  });

  it("a captured link consumed outside acceptInvitation between issue and settle (e.g. by an older build during a rollback window) is never touched by settlement", async () => {
    const { org, oId } = await approvedOrganization();
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // What the previous build's acceptance writes: usedAt only, no acceptedAt.
    const usedAt = new Date();
    await prisma.invitation.update({ where: { id: oId }, data: { usedAt } });
    releases[0]("accepted");

    expect((await resend).invitationSettlement).toBe("settled");
    expect(await row(oId)).toEqual({ usedAt, acceptedAt: null, revokedAt: null });
  });

  // A staff-page Revoke withdraws the whole OFFER (docs/STAFF_INVITATION_RESEND_PLAN.md §2.4, D2 approved): every live
  // invitation with the same exact address, role and academy set. The owner's links (role ADMIN, no academies, the
  // contact address) are one offer, so revoking either one withdraws both — settlement then revives nothing.
  for (const which of ["NEW", "OLD"] as const) {
    it(`concurrent staff revocation of the ${which} link while the email is in flight withdraws the offer: 'unavailable', nothing revived`, async () => {
      const { org, oId } = await approvedOrganization();
      const context = await coOwnerContext(org.id);
      const releases = holdSends();
      const resend = approveOrganization(org.slug, approverId);
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      const nId = (await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id, id: { not: oId } } })).id;

      expect(await revokeStaffInvitation(context, which === "NEW" ? nId : oId)).toEqual({ ok: true });
      const revokedAt = [(await row(oId)).revokedAt, (await row(nId)).revokedAt];
      releases[0]("accepted");

      expect((await resend).invitationSettlement).toBe("unavailable");
      expect(await liveIds(org.id)).toEqual([]);
      expect([(await row(oId)).revokedAt, (await row(nId)).revokedAt]).toEqual(revokedAt);
    });
  }

  it("an earlier link retired by something else before an accepted settlement: settlement skips it (its revokedAt unchanged) and completes", async () => {
    const { org, oId } = await approvedOrganization();
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // A one-row retirement (e.g. by an older settlement), not the offer-wide staff Revoke.
    await prisma.invitation.update({ where: { id: oId }, data: { revokedAt: new Date() } });
    const revokedAt = (await row(oId)).revokedAt;
    releases[0]("accepted");

    const result = await resend;
    expect(result.invitationSettlement).toBe("settled");
    expect((await row(oId)).revokedAt).toEqual(revokedAt);
    expect(await liveIds(org.id)).toEqual([await idOfToken(tokenOf(result.invitationLink))]);
  });

  it("R3a: acceptance queued before issue — issue finds acceptedAt and issues nothing; no email", async () => {
    const { org, oToken } = await approvedOrganization();
    respondWith("accepted");
    let acceptance!: Promise<string>;
    let resend!: ReturnType<typeof approveOrganization>;
    await holdingLock(org.id, async () => {
      acceptance = accept(oToken);
      await untilWaiting(1);
      resend = approveOrganization(org.slug, approverId);
      await untilWaiting(2);
    });
    expect(await acceptance).toBe("accepted");
    expect(await resend).toMatchObject({ invitationIssue: "alreadyAccepted" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("R3b: issue queued before acceptance — the new link is committed first and dies with the acceptance; settlement reports 'acceptedMeanwhile'", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    respondWith("accepted");
    let acceptance!: Promise<string>;
    let resend!: ReturnType<typeof approveOrganization>;
    await holdingLock(org.id, async () => {
      resend = approveOrganization(org.slug, approverId);
      await untilWaiting(1);
      acceptance = accept(oToken);
      await untilWaiting(2);
    });
    expect(await acceptance).toBe("accepted");
    const result = await resend;
    expect(result).toMatchObject({ invitationIssue: "issued", invitationSettlement: "acceptedMeanwhile" });
    expect((await row(oId)).acceptedAt).not.toBeNull();
    expect((await row(await idOfToken(tokenOf(result.invitationLink)))).revokedAt).not.toBeNull();
    expect(await liveIds(org.id)).toEqual([]);
  });

  it("R4: two different live links accepted at once — exactly one wins; one membership, one acceptance audit", async () => {
    const { org, contactEmail, oToken } = await approvedOrganization();
    respondWith("unknown");
    const nToken = tokenOf((await approveOrganization(org.slug, approverId)).invitationLink);

    const outcomes = (await Promise.all([accept(oToken), accept(nToken)])).sort();
    expect(outcomes).toEqual(["accepted", "invalidToken"]);
    expect(await prisma.invitation.count({ where: { organizationId: org.id, acceptedAt: { not: null } } })).toBe(1);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: contactEmail } });
    expect(await prisma.organizationMembership.count({ where: { organizationId: org.id, userId: owner.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "staff.accept" } })).toBe(1);
  });
});

describe("expiry", () => {
  it("E1: a link that expires while its acceptance waits for the lock is refused — fresh time is taken after the lock; nothing written", async () => {
    const { org, contactEmail, oToken, oId } = await approvedOrganization();
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: contactEmail } });
    const start = Date.now();
    await prisma.invitation.update({ where: { id: oId }, data: { expiresAt: new Date(start + 1_500) } });
    vi.useFakeTimers({ toFake: ["Date"], now: start });

    let acceptance!: Promise<string>;
    await holdingLock(org.id, async () => {
      acceptance = accept(oToken); // pre-check passes: still 1.5s to go
      await untilWaiting(1);
      vi.setSystemTime(start + 3_000); // expires while it waits
    });

    expect(await acceptance).toBe("invalidToken");
    expect(await row(oId)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ active: false });
  });
});

describe("transaction failures", () => {
  it("settlement fails after an accepted send: 'failed' is reported with the email outcome, logged neutrally; both links live; the next resend retires both", async () => {
    const { org, contactEmail, oId } = await approvedOrganization();
    respondWith("accepted");
    transactionScript.push("pass", "fail"); // issue, then settle
    const failed = await approveOrganization(org.slug, approverId);

    expect(failed).toMatchObject({ invitationIssue: "issued", invitationEmailOutcome: "accepted", invitationSettlement: "failed" });
    const n1 = await idOfToken(tokenOf(failed.invitationLink));
    expect(await liveIds(org.id)).toEqual([oId, n1]);
    expect(consoleCalls).toContainEqual(["[approve-organization] invitation settle failed", { organizationId: org.id, outcome: "accepted" }]);
    const logged = JSON.stringify(consoleCalls);
    for (const secret of [contactEmail, "token=", "synthetic transaction failure"]) expect(logged).not.toContain(secret);

    const next = await approveOrganization(org.slug, approverId);
    expect(next.invitationSettlement).toBe("settled");
    expect(await liveIds(org.id)).toEqual([await idOfToken(tokenOf(next.invitationLink))]);
  });

  it("issue fails: nothing sent, nothing created", async () => {
    const { org, oId } = await approvedOrganization();
    respondWith("accepted");
    transactionScript.push("fail");
    await expect(approveOrganization(org.slug, approverId)).rejects.toThrow("synthetic transaction failure");
    expect(sendMock).not.toHaveBeenCalled();
    expect(await prisma.invitation.findMany({ where: { organizationId: org.id }, select: { id: true } })).toEqual([{ id: oId }]);
  });

  it("a process lost between issue and settle leaves both links live; the first accepted retires the other", async () => {
    const { org, oToken, oId } = await approvedOrganization();
    const releases = holdSends();
    const resend = approveOrganization(org.slug, approverId); // not answered while we check
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const nId = (await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id, id: { not: oId } } })).id;
    expect(await liveIds(org.id)).toEqual([oId, nId]);

    expect(await accept(oToken)).toBe("accepted");
    expect((await row(nId)).revokedAt).not.toBeNull();
    releases[0]("unknown");
    expect((await resend).invitationSettlement).toBe("acceptedMeanwhile");
  });

  it("acceptance rolls back completely when a later step fails: the consume and the sibling revocation are undone", async () => {
    const { org } = await approvedOrganization();
    const email = `lifecycle-new-${uniqueSuffix()}@example.test`;
    emails.push(email);
    const token = generateRandomToken();
    const pepper = process.env.CODE_PEPPER!;
    const expiresAt = new Date(Date.now() + 86_400_000);
    const target = await prisma.invitation.create({ data: { tokenHash: digestLookupSecret(token, pepper), email, organizationId: org.id, role: "ADMIN", expiresAt } });
    const sibling = await prisma.invitation.create({
      data: { tokenHash: digestLookupSecret(generateRandomToken(), pepper), email, organizationId: org.id, role: "ADMIN", expiresAt },
    });

    let acceptance!: Promise<string>;
    await holdingLock(org.id, async () => {
      acceptance = accept(token); // pre-read: no account yet, so it will create one
      await untilWaiting(1);
      // The account appears meanwhile: the acceptance's user.create then hits the unique email, after consuming.
      await prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-1"), role: "ADMIN" } });
    });

    await expect(acceptance).rejects.toThrow();
    expect(await row(target.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
    expect(await row(sibling.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
  });
});

describe("owner-resend blocker diagnostic (read-only)", () => {
  const legacyRow = (organizationId: string, email: string, extra: { usedAt?: Date; acceptedAt?: Date } = {}) =>
    prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(generateRandomToken(), process.env.CODE_PEPPER!),
        email,
        organizationId,
        role: "ADMIN",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedAt: extra.usedAt ?? new Date(Date.now() - 2_000),
        acceptedAt: extra.acceptedAt,
      },
    });

  it("reports exactly the organizations whose owner resend is blocked — same predicates as the app; ids and counts only; writes nothing", async () => {
    // Blocked: a legacy-used invitation to the owner's exact contact address.
    const blocked = await approvedOrganization();
    const usedAt = new Date(Date.now() - 2_000);
    await legacyRow(blocked.org.id, blocked.contactEmail, { usedAt });

    // NOT blocked: the only legacy-used rows are an unrelated staff address and a case-variant address.
    const unrelated = await approvedOrganization();
    const staffEmail = `lifecycle-staff-${uniqueSuffix()}@example.test`;
    await legacyRow(unrelated.org.id, staffEmail);
    await legacyRow(unrelated.org.id, unrelated.contactEmail.toUpperCase());

    // NOT blocked: an owner legacy row, but the owner also genuinely accepted — acceptance takes precedence.
    const accepted = await approvedOrganization();
    await legacyRow(accepted.org.id, accepted.contactEmail);
    expect(await accept(accepted.oToken)).toBe("accepted");

    const before = await prisma.invitation.findMany({ orderBy: { id: "asc" } });
    const report = await reportOwnerResendBlockers();
    expect(await prisma.invitation.findMany({ orderBy: { id: "asc" } })).toEqual(before);

    const reported = new Set(report.map((entry) => entry.organizationId));
    expect(reported.has(blocked.org.id)).toBe(true);
    expect(reported.has(unrelated.org.id)).toBe(false);
    expect(reported.has(accepted.org.id)).toBe(false);
    const mine = report.find((entry) => entry.organizationId === blocked.org.id)!;
    expect(mine).toMatchObject({ legacyUsedCount: 1, liveInvitationCount: 1, earliestUsedAt: usedAt, latestUsedAt: usedAt });
    // O was created within the window of the fixture's usedAt — reported, and (by the module's own label) proves nothing.
    expect(mine.successorObservedCount).toBe(1);
    const output = JSON.stringify(report);
    for (const address of [blocked.contactEmail, unrelated.contactEmail, staffEmail]) expect(output).not.toContain(address);
    expect(output).not.toMatch(/tokenHash|token=|@/);

    // The report agrees with what the application does for each organization.
    respondWith("accepted");
    expect(await approveOrganization(blocked.org.slug, approverId)).toMatchObject({ invitationIssue: "legacyUnresolved" });
    expect(await approveOrganization(unrelated.org.slug, approverId)).toMatchObject({ invitationIssue: "issued" });
    expect(await approveOrganization(accepted.org.slug, approverId)).toMatchObject({ invitationIssue: "alreadyAccepted" });
  });
});
