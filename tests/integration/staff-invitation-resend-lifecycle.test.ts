import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import type { EmailSendOutcome } from "../../src/lib/email/send-transactional-email";

/**
 * docs/STAFF_INVITATION_RESEND_PLAN.md (revision 2, D1–D4 approved) — the staff invitation lifecycle under every send
 * outcome and every ordering the plan lists. Real Postgres throughout (the isolated test database).
 *
 * Determinism, with no production test hook (the same harness as invitation-lifecycle.test.ts):
 * - provider responses are HELD (the email helper is mocked to return a promise the test resolves), so the test decides
 *   when settlement runs — and the send is only ever called after the issue transaction committed;
 * - "settle takes the lock" uses a HELD LOCK: the test takes the organization's advisory lock and waits until
 *   `pg_locks` shows settlement queued behind it;
 * - expiry while waiting fakes `Date` only (no timers), so Postgres I/O stays real;
 * - a settlement failure comes from wrapping this file's import of `@/lib/prisma` (test-only module mock).
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

const { inviteStaffMember, resendStaffInvitation, revokeStaffInvitation } = await import("../../src/lib/staff/staff-service");
const { listStaff, usableInvitationIds } = await import("../../src/lib/staff/list-staff");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");

type Delivery = Awaited<ReturnType<typeof resendStaffInvitation>>;
type Context = Awaited<ReturnType<typeof requireOrganizationAccess>>;

const prisma = getTestPrismaClient();
const orgIds: string[] = [];
const emails: string[] = [];
let consoleCalls: unknown[][] = [];
let counter = 0;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

const sendResult = (outcome: EmailSendOutcome) => ({ success: outcome === "accepted", outcome });
const respondWith = (outcome: EmailSendOutcome) => sendMock.mockImplementation(async () => sendResult(outcome));

/** Every send from now on waits; `releases[i](outcome)` answers the i-th one. */
function holdSends(): Array<(outcome: EmailSendOutcome) => void> {
  const releases: Array<(outcome: EmailSendOutcome) => void> = [];
  sendMock.mockImplementation(() => new Promise((resolve) => releases.push((outcome) => resolve(sendResult(outcome)))));
  return releases;
}
/** Resolves once `n` sends are waiting — i.e. `n` issue transactions have committed. */
const untilSends = (releases: unknown[], n: number) => vi.waitFor(() => expect(releases).toHaveLength(n), { timeout: 10_000, interval: 10 });

const TOKEN_IN_LINK = /accept-invitation\?token=([A-Za-z0-9_-]+)/;
const tokenOf = (link: string | undefined) => new URL(link!).searchParams.get("token")!;
/** The token the i-th email carried (the link is only returned to the Owner after settlement). */
const sentToken = (i: number) => (sendMock.mock.calls[i][2] as string[]).join("\n").match(TOKEN_IN_LINK)![1];
const idOfToken = async (token: string) =>
  (await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: digestLookupSecret(token, process.env.CODE_PEPPER!) } })).id;
const row = (id: string) => prisma.invitation.findUniqueOrThrow({ where: { id } });
const isLive = async (id: string) => {
  const r = await row(id);
  return r.usedAt === null && r.revokedAt === null;
};
const auditRows = (organizationId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId, action }, orderBy: { createdAt: "asc" } });

/** An ACTIVE organization with an Owner and three academies; returns the Owner's verified tenant context. */
async function organization() {
  counter += 1;
  const org = await prisma.organization.create({
    data: { slug: `staff-resend-${suffix}-${counter}`, name: `Staff resend ${counter}`, status: "ACTIVE", city: "Heredia", country: "Costa Rica" },
  });
  orgIds.push(org.id);
  const academy = (name: string) =>
    prisma.academy.create({
      data: {
        organizationId: org.id,
        name: `${name} ${counter}`,
        slug: `staff-resend-${name.toLowerCase()}-${suffix}-${counter}`,
        kioskTokenHash: digestLookupSecret(`staff-resend-kiosk-${name}-${suffix}-${counter}`, process.env.CODE_PEPPER!),
      },
    });
  const [a, b, c] = [await academy("A"), await academy("B"), await academy("C")];
  const ownerEmail = `staff-resend-owner-${counter}-${suffix}@example.test`;
  emails.push(ownerEmail);
  const owner = await prisma.user.create({ data: { email: ownerEmail, passwordHash: await hashSecret("owner-password-123"), role: "ADMIN", active: true } });
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: org.id, role: "ADMIN", active: true } });
  const context: Context = await requireOrganizationAccess(owner.id, org.id);
  return { org, context, academyA: a.id, academyB: b.id, academyC: c.id };
}

function invitee(label: string) {
  const email = `staff-resend-${label}-${++counter}-${suffix}@example.test`;
  emails.push(email);
  return email;
}

/** A first invitation, provider-accepted and settled: P. */
async function invite(context: Context, email: string, role: string, academyIds: string[]) {
  respondWith("accepted");
  const result = await inviteStaffMember(context, { email, role, academyIds });
  if (!("ok" in result)) throw new Error(`invite refused: ${result.error}`);
  expect(result.settlement).toBe("settled");
  sendMock.mockClear();
  return { id: result.invitationId, token: tokenOf(result.invitationLink) };
}

/** Accepts like a request does. "accepted" = committed (redirected into a session, or ok for an existing account). */
async function accept(token: string): Promise<string> {
  const fd = new FormData();
  fd.set("token", token);
  fd.set("password", "Staff-resend-password-1");
  try {
    const result = await acceptInvitation("en", {}, fd);
    return result.ok ? "accepted" : (result.error ?? "none");
  } catch (error) {
    if ((error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) return "accepted";
    throw error;
  }
}

async function lockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0].n;
}
const untilWaiting = (n: number) => vi.waitFor(async () => expect(await lockWaiters()).toBe(n), { timeout: 10_000, interval: 20 });

async function holdingLock(organizationId: string, body: () => Promise<void>) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))::text AS locked`;
      await body();
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
}

const ok = (result: Delivery) => {
  if (!("ok" in result)) throw new Error(`refused: ${result.error}`);
  return result;
};

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
  await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("resend by outcome (D1)", () => {
  it("REQUIRED accepted: the earlier link keeps working while the email is in flight; after settlement it is retired, the new one works, audited", async () => {
    const { org, context, academyA } = await organization();
    const p = await invite(context, invitee("accepted"), "INSTRUCTOR", [academyA]);

    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    const nId = await idOfToken(sentToken(0));
    expect(await isLive(p.id)).toBe(true); // nothing invalidated before the outcome is known
    expect(await isLive(nId)).toBe(true);

    releases[0]("accepted");
    const result = ok(await pending);
    expect(result).toMatchObject({ invitationId: nId, emailOutcome: "accepted", settlement: "settled" });
    expect(await isLive(p.id)).toBe(false);
    expect(await accept(p.token)).toBe("invalidToken");
    const superseded = await auditRows(org.id, "staff.invitationSuperseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ entityId: nId, before: { invitationIds: [p.id] } });
    expect(await accept(tokenOf(result.invitationLink))).toBe("accepted");
  });

  it("REQUIRED rejected / not_configured: this resend invalidates nothing — both links stay, the manual link is returned; accepting either retires the other", async () => {
    for (const outcome of ["rejected", "not_configured"] as const) {
      const { context, academyA } = await organization();
      const p = await invite(context, invitee(outcome), "INSTRUCTOR", [academyA]);
      respondWith(outcome);
      const result = ok(await resendStaffInvitation(context, p.id));
      expect(result).toMatchObject({ emailOutcome: outcome, settlement: "settled", invitationLink: expect.any(String) });
      expect(await isLive(p.id)).toBe(true);
      expect(await isLive(result.invitationId)).toBe(true);

      expect(await accept(tokenOf(result.invitationLink))).toBe("accepted");
      expect(await isLive(p.id)).toBe(false);
      expect(await accept(p.token)).toBe("invalidToken");
    }
  });

  it("unknown: both stay; the earlier link accepted first retires the new one", async () => {
    const { context, academyA } = await organization();
    const p = await invite(context, invitee("unknown"), "INSTRUCTOR", [academyA]);
    respondWith("unknown");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(result).toMatchObject({ emailOutcome: "unknown", settlement: "settled" });
    expect(await isLive(p.id)).toBe(true);

    expect(await accept(p.token)).toBe("accepted");
    expect(await isLive(result.invitationId)).toBe(false);
    expect(await accept(tokenOf(result.invitationLink))).toBe("invalidToken");
  });
});

describe("acceptance evidence: only the new invitation's own acceptedAt", () => {
  it("REQUIRED the earlier link accepted while the email is in flight → 'unavailable' (neutral), no link, settlement writes nothing", async () => {
    const { org, context, academyA } = await organization();
    const p = await invite(context, invitee("p-accepted"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    const nId = await idOfToken(sentToken(0));

    expect(await accept(p.token)).toBe("accepted"); // the existing sibling rule revokes N with it
    releases[0]("accepted");
    const result = ok(await pending);

    expect(result.settlement).toBe("unavailable");
    expect(result.invitationLink).toBeUndefined();
    expect((await row(nId)).revokedAt).not.toBeNull();
    expect((await row(p.id)).acceptedAt).not.toBeNull();
    expect(await auditRows(org.id, "staff.invitationSuperseded")).toHaveLength(0);
  });

  it("REQUIRED the NEW link accepted before settlement → 'acceptedMeanwhile', no link", async () => {
    const { context, academyA } = await organization();
    const p = await invite(context, invitee("n-accepted"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);

    expect(await accept(sentToken(0))).toBe("accepted");
    releases[0]("accepted");
    const result = ok(await pending);

    expect(result.settlement).toBe("acceptedMeanwhile");
    expect(result.invitationLink).toBeUndefined();
    expect(await isLive(p.id)).toBe(false); // retired by that acceptance, not by settlement
  });

  it("REQUIRED a different-scope offer to the same address accepted mid-flight → 'unavailable'", async () => {
    const { context, academyA, academyB } = await organization();
    const email = invitee("other-scope");
    const p = await invite(context, email, "INSTRUCTOR", [academyA]);
    await prisma.invitation.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // lets a 2nd offer be issued
    const y = await invite(context, email, "DIRECTOR", [academyB]);

    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    expect(await accept(y.token)).toBe("accepted");
    releases[0]("accepted");

    expect(ok(await pending)).toMatchObject({ settlement: "unavailable" });
  });

  it("REQUIRED an OLD acceptance by the same address (before this resend) is not taken as 'accepted meanwhile' — settles normally", async () => {
    const { org, context, academyA } = await organization();
    const email = invitee("old-acceptance");
    // e.g. someone who joined as staff long ago and was later made student-only, now invited again
    const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(`old-${email}`, process.env.CODE_PEPPER!),
        email,
        organizationId: org.id,
        role: "INSTRUCTOR",
        academyIds: [academyA],
        expiresAt: long,
        usedAt: long,
        acceptedAt: long,
        createdAt: long,
      },
    });
    const p = await invite(context, email, "INSTRUCTOR", [academyA]);
    respondWith("accepted");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(result.settlement).toBe("settled");
    expect(await isLive(p.id)).toBe(false);
  });
});

describe("explicit revocation is authoritative (D2: the whole offer)", () => {
  it("REQUIRED revoke before the resend issues → 'notPending', nothing sent", async () => {
    const { context, academyA } = await organization();
    const p = await invite(context, invitee("revoked-first"), "INSTRUCTOR", [academyA]);
    expect(await revokeStaffInvitation(context, p.id)).toEqual({ ok: true });
    expect(await resendStaffInvitation(context, p.id)).toEqual({ error: "notPending" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("REQUIRED revoke while the new email is in flight withdraws the new link too; a provider-accepted settlement then revives and retires nothing", async () => {
    const { context, academyA } = await organization();
    const p = await invite(context, invitee("revoked-in-flight"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    const nId = await idOfToken(sentToken(0));

    expect(await revokeStaffInvitation(context, p.id)).toEqual({ ok: true });
    const revokedAt = { p: (await row(p.id)).revokedAt, n: (await row(nId)).revokedAt };
    expect(revokedAt.n).not.toBeNull();

    releases[0]("accepted");
    const result = ok(await pending);
    expect(result.settlement).toBe("unavailable");
    expect(result.invitationLink).toBeUndefined();
    expect((await row(p.id)).revokedAt).toEqual(revokedAt.p);
    expect((await row(nId)).revokedAt).toEqual(revokedAt.n);
    expect(await accept(sentToken(0))).toBe("invalidToken");
  });

  it("a first invite revoked while its email is in flight → 'unavailable', no link", async () => {
    const { context, academyA } = await organization();
    const releases = holdSends();
    const pending = inviteStaffMember(context, { email: invitee("first-revoked"), role: "INSTRUCTOR", academyIds: [academyA] });
    await untilSends(releases, 1);
    expect(await revokeStaffInvitation(context, await idOfToken(sentToken(0)))).toEqual({ ok: true });
    releases[0]("accepted");
    expect(await pending).toMatchObject({ ok: true, settlement: "unavailable" });
    expect(await pending).not.toHaveProperty("invitationLink");
  });
});

describe("concurrency", () => {
  it("REQUIRED settlement takes the organization lock: a change committed while it waits is what it sees", async () => {
    const { org, context, academyA } = await organization();
    const p = await invite(context, invitee("lock"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    const nId = await idOfToken(sentToken(0));

    await holdingLock(org.id, async () => {
      releases[0]("accepted");
      await untilWaiting(1); // settlement is queued behind the held lock
      await prisma.invitation.update({ where: { id: nId }, data: { revokedAt: new Date() } });
    });

    expect(ok(await pending).settlement).toBe("unavailable");
    expect(await isLive(p.id)).toBe(true);
  });

  for (const order of ["newer settles first", "older settles first"] as const) {
    it(`REQUIRED two resends of the same offer (${order}): a late settlement never retires an invitation issued after its own`, async () => {
      const { org, context, academyA } = await organization();
      const p = await invite(context, invitee(order.split(" ")[0]), "INSTRUCTOR", [academyA]);
      const releases = holdSends();
      const r1 = resendStaffInvitation(context, p.id);
      await untilSends(releases, 1);
      const n1 = await idOfToken(sentToken(0));
      const r2 = resendStaffInvitation(context, p.id); // P is still live: allowed, and its snapshot includes N1
      await untilSends(releases, 2);
      const n2 = await idOfToken(sentToken(1));

      if (order === "newer settles first") {
        releases[1]("accepted");
        expect(ok(await r2).settlement).toBe("settled");
        expect([await isLive(p.id), await isLive(n1), await isLive(n2)]).toEqual([false, false, true]);
        releases[0]("accepted");
        expect(ok(await r1).settlement).toBe("unavailable");
      } else {
        releases[0]("accepted");
        expect(ok(await r1).settlement).toBe("settled");
        expect([await isLive(p.id), await isLive(n1), await isLive(n2)]).toEqual([false, true, true]);
        const pRevokedAt = (await row(p.id)).revokedAt;
        releases[1]("accepted");
        expect(ok(await r2).settlement).toBe("settled");
        expect((await row(p.id)).revokedAt).toEqual(pRevokedAt); // never rewrites a row that is no longer live
        const audits = await auditRows(org.id, "staff.invitationSuperseded");
        expect(audits.map((audit) => audit.before)).toEqual([{ invitationIds: [p.id] }, { invitationIds: [n1] }]);
      }
      expect(await isLive(n2)).toBe(true); // the newest invitation survives either order
    });
  }

  it("REQUIRED the new invitation expiring before settlement (fresh time after the lock) → 'unavailable', nothing retired", async () => {
    const { context, academyA } = await organization();
    const p = await invite(context, invitee("expiry"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    const n = await row(await idOfToken(sentToken(0)));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(n.expiresAt.getTime() + 1000));
    releases[0]("accepted");
    expect(ok(await pending).settlement).toBe("unavailable");
    vi.useRealTimers();
    expect(await isLive(p.id)).toBe(true);
  });

  it("REQUIRED a settlement failure → 'failed': nothing invalidated, the link offered as unverified, one fixed log line", async () => {
    const { org, context, academyA } = await organization();
    const p = await invite(context, invitee("settle-fail"), "INSTRUCTOR", [academyA]);
    const releases = holdSends();
    const pending = resendStaffInvitation(context, p.id);
    await untilSends(releases, 1);
    transactionScript.push("fail"); // the next $transaction is settlement's

    releases[0]("accepted");
    const result = ok(await pending);
    expect(result).toMatchObject({ settlement: "failed", emailOutcome: "accepted", invitationLink: expect.any(String) });
    expect(await isLive(p.id)).toBe(true);
    expect(await isLive(result.invitationId)).toBe(true);
    expect(consoleCalls).toEqual([["[staff] invitation settle failed", { organizationId: org.id, outcome: "accepted" }]]);
  });
});

describe("offer scope and identity", () => {
  it("REQUIRED a different-scope live offer to the same address is untouched by an accepted resend and by revoke", async () => {
    const { context, academyA, academyB } = await organization();
    const email = invitee("scope");
    const p = await invite(context, email, "INSTRUCTOR", [academyA]);
    await prisma.invitation.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const y = await invite(context, email, "DIRECTOR", [academyB]);

    respondWith("accepted");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(await isLive(p.id)).toBe(false);
    expect(await isLive(y.id)).toBe(true);
    expect(await revokeStaffInvitation(context, result.invitationId)).toEqual({ ok: true });
    expect(await isLive(y.id)).toBe(true);
  });

  it("REQUIRED an invitation to an address differing only by case is never touched (exact address, as acceptance uses)", async () => {
    const { org, context, academyA } = await organization();
    const lower = invitee("case");
    const upper = lower.replace("staff-resend-case", "Staff-Resend-Case");
    emails.push(upper);
    const p = await invite(context, lower, "INSTRUCTOR", [academyA]);
    // The invite form refuses a case-variant pending invitation, so this one is created directly.
    const variant = await prisma.invitation.create({
      data: {
        tokenHash: digestLookupSecret(`variant-${upper}`, process.env.CODE_PEPPER!),
        email: upper,
        organizationId: org.id,
        role: "INSTRUCTOR",
        academyIds: [academyA],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    respondWith("accepted");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(await isLive(variant.id)).toBe(true);
    expect(await revokeStaffInvitation(context, result.invitationId)).toEqual({ ok: true });
    expect(await isLive(variant.id)).toBe(true);
  });

  it("REQUIRED academy matching is order-independent; the replacement copies role and academyIds exactly as stored", async () => {
    const { org, context, academyA, academyB } = await organization();
    const email = invitee("order");
    const p = await invite(context, email, "DIRECTOR", [academyA, academyB]);
    const stored = (await row(p.id)).academyIds;
    const reordered = (tag: string) =>
      prisma.invitation.create({
        data: {
          tokenHash: digestLookupSecret(`${tag}-${email}`, process.env.CODE_PEPPER!),
          email,
          organizationId: org.id,
          role: "DIRECTOR",
          academyIds: [...stored].reverse(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const sameSetOtherOrder = await reordered("reordered-1");

    respondWith("accepted");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(await isLive(sameSetOtherOrder.id)).toBe(false); // captured as the same offer and retired
    const n = await row(result.invitationId);
    expect(n.role).toBe("DIRECTOR");
    expect(n.academyIds).toEqual(stored);

    const q = await reordered("reordered-2");
    expect(await revokeStaffInvitation(context, result.invitationId)).toEqual({ ok: true });
    expect(await isLive(q.id)).toBe(false); // revoke withdraws it as the same offer
  });

  it("an expired invitation can be resent; an academy removed before acceptance still refuses the link", async () => {
    const { context, academyA, academyC } = await organization();
    const p = await invite(context, invitee("expired-scope"), "INSTRUCTOR", [academyA, academyC]);
    await prisma.invitation.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    respondWith("accepted");
    const result = ok(await resendStaffInvitation(context, p.id));
    expect(result.settlement).toBe("settled");
    expect(await isLive(p.id)).toBe(false);

    await prisma.academy.delete({ where: { id: academyC } });
    expect(await accept(tokenOf(result.invitationLink))).toBe("invalidToken");
  });

  it("authorization is unchanged: a non-Owner context is refused before anything is issued", async () => {
    const { context } = await organization();
    await expect(resendStaffInvitation({ ...context, organizationRole: "DIRECTOR" }, "any")).rejects.toThrow("FORBIDDEN");
    await expect(revokeStaffInvitation({ ...context, organizationRole: "INSTRUCTOR" }, "any")).rejects.toThrow("FORBIDDEN");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("the link panel's usable set comes from listStaff's own data", () => {
  it("REQUIRED an invitation still in the pending list but expired is NOT usable; pending + unexpired is", async () => {
    const { org, context, academyA } = await organization();
    const expired = await invite(context, invitee("listed-expired"), "INSTRUCTOR", [academyA]);
    const fresh = await invite(context, invitee("listed-fresh"), "INSTRUCTOR", [academyA]);
    await prisma.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const { invitations } = await listStaff(org.id);
    expect(invitations.find((invitation) => invitation.id === expired.id)).toMatchObject({ expired: true }); // still listed
    const usable = usableInvitationIds(invitations);
    expect(usable).not.toContain(expired.id);
    expect(usable).toContain(fresh.id);
  });
});
