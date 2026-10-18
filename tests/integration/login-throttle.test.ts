import "dotenv/config";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { decode } from "next-auth/jwt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * docs/LOGIN_THROTTLING_PLAN.md (rev 2), against the isolated test database.
 *
 * Entry points driven for real:
 *  - the direct Auth.js endpoint = the real `handlers.POST /api/auth/callback/credentials` from src/auth.ts, with a CSRF
 *    token from the real `handlers.GET /api/auth/csrf`;
 *  - the login action = the real `login` server action, whose real `signIn("credentials")` runs the real Credentials
 *    `authorize`. Only `next/headers` is replaced, to supply the request headers and a cookie jar that a Next.js request
 *    would provide outside of a running server;
 *  - invitation acceptance = the real `acceptInvitation` action, same real `signIn`.
 * Replaced: `next/headers` (above); `auth()` only, for the staff/student-approval actions used to BUILD fixtures;
 * bcryptjs `compare` wrapped (passthrough) to count calls and hold one deterministically; the outbound email and
 * notification side effects; a Prisma Proxy that injects failures when a test turns one on.
 */
const state = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  cookies: new Map<string, string>(),
  session: null as null | { user: { id: string }; activeOrganizationId?: string },
  compareCalls: 0,
  hold: null as null | { password: string; entered: () => void; released: Promise<void> },
  faults: { reserve: false, release: false, userRead: false, membershipRead: false, message: "synthetic outage" },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.headers),
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
    getAll: () => [...state.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => state.cookies.has(name),
    set: (name: string, value: string) => void state.cookies.set(name, value),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  draftMode: async () => ({ isEnabled: false }),
}));

vi.mock("@/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auth")>()),
  auth: () => Promise.resolve(state.session),
}));

vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bcryptjs") & { default?: typeof import("bcryptjs") }>();
  const real = actual.default ?? actual;
  const compare = async (password: string, hash: string) => {
    state.compareCalls += 1;
    const hold = state.hold;
    if (hold && password === hold.password) {
      state.hold = null;
      hold.entered();
      await hold.released;
    }
    return real.compare(password, hash);
  };
  const wrapped = { ...real, compare };
  return { ...wrapped, default: wrapped };
});

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prisma")>();
  const real = actual.prisma as unknown as Record<string | symbol, unknown>;
  const fail = () =>
    Promise.reject(Object.assign(new Error(state.faults.message), { code: "P1001", name: "PrismaClientKnownRequestError" }));
  const delegateFaults: Record<string, Record<string, () => boolean>> = {
    loginAttempt: { deleteMany: () => state.faults.release },
    user: { findUnique: () => state.faults.userRead },
    organizationMembership: { findMany: () => state.faults.membershipRead },
  };
  const prisma = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "$transaction" && state.faults.reserve) return fail;
      const faultsFor = typeof prop === "string" ? delegateFaults[prop] : undefined;
      if (faultsFor) {
        return new Proxy(value as object, {
          get(delegate, method) {
            if (typeof method === "string" && faultsFor[method]?.()) return fail;
            const v = Reflect.get(delegate, method, delegate);
            return typeof v === "function" ? v.bind(delegate) : v;
          },
        });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...actual, prisma };
});

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true, outcome: "accepted" })),
}));
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const { handlers } = await import("../../src/auth");
const { login } = await import("../../src/app/[locale]/login/actions");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { inviteStaff } = await import("../../src/lib/staff/staff-actions");
const throttle = await import("../../src/lib/auth/login-throttle");
const { hashSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const { LOGIN_PAIR_LIMIT, LOGIN_ACCOUNT_LIMIT, LOGIN_IP_LIMIT, authorizeCredentials, loginThrottleKeys, sweepExpiredLoginAttempts } = throttle;
const prisma = getTestPrismaClient();
const BASE = "http://localhost:3000";
const SESSION_COOKIE = "authjs.session-token";
const PASSWORD = "Correct-Passw0rd";
const WRONG = "Wrong-Passw0rd";
const UNIFORM_FAILURE = `${BASE}/login?error=CredentialsSignin&code=credentials`;
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SWEEP_OLD = `sweep-test-old-${run}`;
const SWEEP_RECENT = `sweep-test-recent-${run}`;
let n = 0;
const emailsUsed = new Set<string>();
const userIds: string[] = [];
const orgIds: string[] = [];
const registrationEmails: string[] = [];
let approverId: string;

function uniqueEmail(label: string): string {
  n += 1;
  const email = `throttle-${label}-${n}-${run}@example.test`;
  emailsUsed.add(email);
  return email;
}

function uniqueIp(): string {
  n += 1;
  const salt = Number(run.slice(-3)) % 200;
  return `10.${salt}.${(n >> 8) & 255}.${n & 255}`;
}

async function makeUser(label: string, options: { active?: boolean } = {}) {
  const email = uniqueEmail(label);
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashSecret(PASSWORD), role: "ADMIN", active: options.active ?? true },
  });
  userIds.push(user.id);
  return user;
}

function requestHeaders(ip: string | null): Record<string, string> {
  return { host: "localhost:3000", "x-forwarded-proto": "http", ...(ip ? { "x-forwarded-for": ip } : {}) };
}

/** Counted rows for one account (optionally one account + IP pair), straight from the table. */
async function countedRows(email: string, ip?: string | null): Promise<number> {
  const keys = loginThrottleKeys(email, ip ?? null);
  return prisma.loginAttempt.count({ where: { accountDigest: keys.account, ...(ip ? { ipDigest: keys.ip } : {}) } });
}

/** Pre-existing counted rows, e.g. a saturated pair, or aged rows for the expiry tests. */
async function seedRows(email: string, ip: string | null, count: number, ageMs = 0): Promise<void> {
  const keys = loginThrottleKeys(email, ip);
  const createdAt = new Date(Date.now() - ageMs);
  await prisma.loginAttempt.createMany({ data: Array.from({ length: count }, () => ({ accountDigest: keys.account, ipDigest: keys.ip, createdAt })) });
}

/** The real Credentials `authorize`, called with the Request shape Auth.js hands it. */
function authorize(email: string, password: string, ip: string | null) {
  return authorizeCredentials({ email, password }, new Request(`${BASE}/api/auth/callback/credentials`, { headers: requestHeaders(ip) }));
}

/** The real direct endpoint: CSRF from GET /api/auth/csrf, then POST /api/auth/callback/credentials. */
async function endpointLogin(email: string, password: string, ip: string | null) {
  const csrf = await handlers.GET(new NextRequest(`${BASE}/api/auth/csrf`, { headers: requestHeaders(ip) }));
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const csrfCookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await handlers.POST(
    new NextRequest(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { ...requestHeaders(ip), cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password, csrfToken, callbackUrl: `${BASE}/en/dashboard` }),
    }),
  );
  const session = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return {
    location: response.headers.get("location"),
    sessionCookie: session ? session.slice(SESSION_COOKIE.length + 1).split(";")[0] || null : null,
  };
}

/** Runs a server action as a request would: headers in, cookies out, NEXT_REDIRECT captured. */
async function runAction<T>(ip: string | null, action: () => Promise<T>) {
  state.headers = requestHeaders(ip);
  state.cookies.clear();
  try {
    const result = await action();
    return { result, redirect: null as string | null, sessionCookie: state.cookies.get(SESSION_COOKIE) || null };
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest?.startsWith("NEXT_REDIRECT")) throw error;
    return { result: undefined, redirect: digest.split(";")[2], sessionCookie: state.cookies.get(SESSION_COOKIE) || null };
  }
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function actionLogin(email: string, password: string, ip: string | null, callbackUrl?: string) {
  return runAction(ip, () => login("en", callbackUrl, {}, form({ email, password })));
}

/** Captures everything written to the console while `fn` runs. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; output: string; warnings: unknown[][] }> {
  const lines: string[] = [];
  const warnings: unknown[][] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack}` : v)))).join(" "));
      if (method === "warn") warnings.push(args);
    }),
  );
  try {
    return { value: await fn(), output: lines.join("\n"), warnings };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** A freshly registered + approved academy, created through the product flow; its Owner invitation is not yet accepted. */
async function newOrganization() {
  n += 1;
  const email = uniqueEmail("owner");
  const slug = `throttle-${run}-${n}`;
  registrationEmails.push(email);
  const registration = await runAction(uniqueIp(), () =>
    registerOrganization(
      {},
      form({
        organizationName: `Throttle ${n}`,
        desiredSlug: slug,
        country: "Costa Rica",
        city: "Heredia",
        contactName: "Owner",
        contactEmail: email,
        contactPhone: "88880000",
        studentCountBand: "1-25",
        preferredLocale: "es",
        termsAccepted: "on",
      }),
    ),
  );
  expect(registration.result, JSON.stringify(registration.result)).toMatchObject({ ok: true });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  const token = new URL(approval.invitationLink!).searchParams.get("token")!;
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, slug, academySlug: academy.slug, academyId: academy.id, email, token };
}

describe("login throttling (docs/LOGIN_THROTTLING_PLAN.md)", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: uniqueEmail("approver"), passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    state.session = null;
    state.hold = null;
    state.faults = { reserve: false, release: false, userRead: false, membershipRead: false, message: "synthetic outage" };
  });

  afterAll(async () => {
    const digests = [...emailsUsed].map((email) => loginThrottleKeys(email, null).account);
    await prisma.loginAttempt.deleteMany({ where: { accountDigest: { in: [...digests, SWEEP_OLD, SWEEP_RECENT] } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.studentStatusChange.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.student.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.registrationAttempt.deleteMany({ where: { email: { in: registrationEmails } } });
    const created = await prisma.user.findMany({ where: { email: { in: [...emailsUsed] } }, select: { id: true } });
    await prisma.user.deleteMany({ where: { id: { in: [...userIds, ...created.map((u) => u.id)] } } });
  });

  describe("one enforcement point: the login action and the direct endpoint share the same limits", () => {
    it("1a. failures through the login action throttle the direct endpoint, even with the correct password", async () => {
      const user = await makeUser("action-to-endpoint");
      const ip = uniqueIp();
      for (let i = 0; i < LOGIN_PAIR_LIMIT; i += 1) {
        expect((await actionLogin(user.email, WRONG, ip)).result).toEqual({ error: "invalidCredentials" });
      }
      expect(await countedRows(user.email, ip)).toBe(LOGIN_PAIR_LIMIT);
      expect(await endpointLogin(user.email, PASSWORD, ip)).toEqual({ location: UNIFORM_FAILURE, sessionCookie: null });
      // Not a property of the account: the same correct password from another IP still signs in.
      expect((await endpointLogin(user.email, PASSWORD, uniqueIp())).sessionCookie).not.toBeNull();
    });

    it("1b. failures through the direct endpoint throttle the login action, even with the correct password", async () => {
      const user = await makeUser("endpoint-to-action");
      const ip = uniqueIp();
      for (let i = 0; i < LOGIN_PAIR_LIMIT; i += 1) {
        expect(await endpointLogin(user.email, WRONG, ip)).toEqual({ location: UNIFORM_FAILURE, sessionCookie: null });
      }
      expect(await countedRows(user.email, ip)).toBe(LOGIN_PAIR_LIMIT);
      expect(await actionLogin(user.email, PASSWORD, ip)).toEqual({ result: { error: "invalidCredentials" }, redirect: null, sessionCookie: null });
      const elsewhere = await actionLogin(user.email, PASSWORD, uniqueIp());
      expect(elsewhere.redirect).toMatch(/\/en\/dashboard$/);
      expect(elsewhere.sessionCookie).not.toBeNull();
    });

    it("2. the academy login page renders the same LoginForm (the same `login` action) as the global login", () => {
      const academyPage = readFileSync("src/app/[locale]/o/[orgSlug]/login/page.tsx", "utf8");
      expect(academyPage).toContain('import { LoginForm } from "../../../login/login-form";');
      // No second action or sign-in of its own (its doc comment mentions signIn(), so match code, not prose).
      expect(academyPage).not.toMatch(/^\s*["']use server["']|from "@\/auth"|await signIn\(/m);
    });
  });

  describe("independent thresholds", () => {
    it("3. pair: the 6th attempt from one IP is refused before bcrypt; the same account from another IP is not", async () => {
      const email = uniqueEmail("pair");
      const ip = uniqueIp();
      for (let i = 0; i < LOGIN_PAIR_LIMIT; i += 1) expect(await authorize(email, WRONG, ip)).toBeNull();
      const before = state.compareCalls;
      const { warnings } = await captureConsole(() => authorize(email, WRONG, ip));
      expect(state.compareCalls).toBe(before);
      expect(warnings).toEqual([["[login]", { event: "login.throttled", keyKind: "pair" }]]);
      expect(await countedRows(email, ip)).toBe(LOGIN_PAIR_LIMIT);

      await authorize(email, WRONG, uniqueIp());
      expect(state.compareCalls).toBe(before + 1);
    });

    it("4. account: 5 failures from each of 4 IPs (20) — the next attempt from a 5th, unsaturated IP is refused as `account`", async () => {
      const email = uniqueEmail("account");
      for (let ipIndex = 0; ipIndex < LOGIN_ACCOUNT_LIMIT / LOGIN_PAIR_LIMIT; ipIndex += 1) {
        const ip = uniqueIp();
        for (let i = 0; i < LOGIN_PAIR_LIMIT; i += 1) expect(await authorize(email, WRONG, ip)).toBeNull();
      }
      expect(await countedRows(email)).toBe(LOGIN_ACCOUNT_LIMIT);
      const freshIp = uniqueIp();
      const before = state.compareCalls;
      const { warnings } = await captureConsole(() => authorize(email, WRONG, freshIp));
      expect(state.compareCalls).toBe(before);
      expect(warnings).toEqual([["[login]", { event: "login.throttled", keyKind: "account" }]]);
      expect(await countedRows(email, freshIp)).toBe(0);
    });

    it("5. IP: 5 failures against each of 10 addresses from one IP (50) — an 11th address from that IP is refused as `ip`", async () => {
      const ip = uniqueIp();
      for (let account = 0; account < LOGIN_IP_LIMIT / LOGIN_PAIR_LIMIT; account += 1) {
        const email = uniqueEmail("ip");
        for (let i = 0; i < LOGIN_PAIR_LIMIT; i += 1) expect(await authorize(email, WRONG, ip)).toBeNull();
      }
      const ipDigest = loginThrottleKeys("x", ip).ip!;
      expect(await prisma.loginAttempt.count({ where: { ipDigest } })).toBe(LOGIN_IP_LIMIT);
      const before = state.compareCalls;
      const { warnings } = await captureConsole(() => authorize(uniqueEmail("ip-eleventh"), WRONG, ip));
      expect(state.compareCalls).toBe(before);
      expect(warnings).toEqual([["[login]", { event: "login.throttled", keyKind: "ip" }]]);
    });

    it("6. missing IP: no pair or IP limit, the account limit still applies (20 allowed, the 21st refused)", async () => {
      const email = uniqueEmail("no-ip");
      for (let i = 0; i < LOGIN_ACCOUNT_LIMIT; i += 1) expect(await authorize(email, WRONG, null)).toBeNull();
      const before = state.compareCalls;
      const { warnings } = await captureConsole(() => authorize(email, WRONG, null));
      expect(state.compareCalls).toBe(before);
      expect(warnings).toEqual([["[login]", { event: "login.throttled", keyKind: "account" }]]);
      const keys = loginThrottleKeys(email, null);
      expect(await prisma.loginAttempt.count({ where: { accountDigest: keys.account, ipDigest: null } })).toBe(LOGIN_ACCOUNT_LIMIT);
    });
  });

  describe("concurrency", () => {
    it("7. 20 simultaneous wrong attempts on one pair: exactly 5 reach bcrypt and exactly 5 rows are counted", async () => {
      const user = await makeUser("burst");
      const ip = uniqueIp();
      const before = state.compareCalls;
      const results = await Promise.all(Array.from({ length: 20 }, () => authorize(user.email, WRONG, ip)));
      expect(results.every((r) => r === null)).toBe(true);
      expect(state.compareCalls - before).toBe(LOGIN_PAIR_LIMIT);
      expect(await countedRows(user.email, ip)).toBe(LOGIN_PAIR_LIMIT);
    });

    it("8. mixed, deterministic: a success removes only its own reservation; a pending attempt that later fails stays counted; no bypass", async () => {
      const user = await makeUser("mixed");
      const ip = uniqueIp();
      await seedRows(user.email, ip, 2);

      // a. A (wrong password) reserves and is held inside bcrypt.
      let entered!: () => void;
      let release!: () => void;
      const enteredA = new Promise<void>((resolve) => (entered = resolve));
      state.hold = { password: "Held-Wrong-A", entered, released: new Promise<void>((resolve) => (release = resolve)) };
      const attemptA = authorize(user.email, "Held-Wrong-A", ip);
      await enteredA;
      expect(await countedRows(user.email, ip)).toBe(3);

      // b. B (correct password) succeeds and removes ONLY its own row: A's in-flight row is still counted.
      const b = await authorize(user.email, PASSWORD, ip);
      expect(b?.id).toBe(user.id);
      expect(await countedRows(user.email, ip)).toBe(3);

      // c. While A is still pending: two more attempts fit (5), the next is refused before bcrypt.
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
      expect(await countedRows(user.email, ip)).toBe(5);
      const before = state.compareCalls;
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
      expect(state.compareCalls).toBe(before);

      // d. A completes and fails: its row remains.
      release();
      expect(await attemptA).toBeNull();
      expect(await countedRows(user.email, ip)).toBe(5);

      // e. The correct password is still refused, before bcrypt: the pair is at its limit.
      const beforeCorrect = state.compareCalls;
      expect(await authorize(user.email, PASSWORD, ip)).toBeNull();
      expect(state.compareCalls).toBe(beforeCorrect);
    });

    it("9. a success after 4 failures leaves those 4 counted: one more attempt fits, the next is refused (no counter reset)", async () => {
      const user = await makeUser("no-reset");
      const ip = uniqueIp();
      for (let i = 0; i < 4; i += 1) expect(await authorize(user.email, WRONG, ip)).toBeNull();
      expect((await authorize(user.email, PASSWORD, ip))?.id).toBe(user.id);
      expect(await countedRows(user.email, ip)).toBe(4);
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
      const before = state.compareCalls;
      expect(await authorize(user.email, PASSWORD, ip)).toBeNull();
      expect(state.compareCalls).toBe(before);
    });
  });

  describe("expiry and cleanup", () => {
    it("10. rows older than the 15-minute window stop counting; rows inside it still count; no permanent lock", async () => {
      const user = await makeUser("expiry");
      const ip = uniqueIp();
      await seedRows(user.email, ip, LOGIN_PAIR_LIMIT, 16 * 60 * 1000);
      expect((await authorize(user.email, PASSWORD, ip))?.id).toBe(user.id);

      const other = uniqueIp();
      await seedRows(user.email, other, LOGIN_PAIR_LIMIT, 14 * 60 * 1000);
      expect(await authorize(user.email, PASSWORD, other)).toBeNull();
    });

    it("11. the sweep deletes at most 100 rows older than 24 h per call and never a row inside the retention period", async () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const recent = new Date(Date.now() - 23 * 60 * 60 * 1000);
      await prisma.loginAttempt.createMany({ data: Array.from({ length: 120 }, () => ({ accountDigest: SWEEP_OLD, createdAt: old })) });
      await prisma.loginAttempt.createMany({ data: Array.from({ length: 3 }, () => ({ accountDigest: SWEEP_RECENT, createdAt: recent })) });

      const first = await sweepExpiredLoginAttempts();
      expect(first).toBe(100);
      expect(await prisma.loginAttempt.count({ where: { accountDigest: SWEEP_OLD } })).toBeGreaterThanOrEqual(20);
      while ((await sweepExpiredLoginAttempts()) > 0);
      expect(await prisma.loginAttempt.count({ where: { accountDigest: SWEEP_OLD } })).toBe(0);
      expect(await prisma.loginAttempt.count({ where: { accountDigest: SWEEP_RECENT } })).toBe(3);
    });
  });

  describe("uniform responses, failures and logs", () => {
    it("12. unknown, inactive, wrong password and throttled give the identical action result and the identical endpoint redirect", async () => {
      const active = await makeUser("uniform");
      const inactive = await makeUser("uniform-inactive", { active: false });
      const throttledIp = uniqueIp();
      await seedRows(active.email, throttledIp, LOGIN_PAIR_LIMIT);
      const cases: [string, string, string][] = [
        [uniqueEmail("uniform-unknown"), PASSWORD, uniqueIp()],
        [inactive.email, PASSWORD, uniqueIp()],
        [active.email, WRONG, uniqueIp()],
        [active.email, PASSWORD, throttledIp],
      ];
      for (const [email, password, ip] of cases) {
        expect(await actionLogin(email, password, ip)).toEqual({ result: { error: "invalidCredentials" }, redirect: null, sessionCookie: null });
      }
      for (const [email, password, ip] of cases) {
        expect(await endpointLogin(email, password, ip)).toEqual({ location: UNIFORM_FAILURE, sessionCookie: null });
      }
    });

    it("13. reservation failure fails closed: a correct password is refused with the uniform redirect (not `Configuration`); nothing raw is logged", async () => {
      const user = await makeUser("reserve-fails");
      const ip = uniqueIp();
      state.faults.reserve = true;
      state.faults.message = `connection to db lost while querying ${user.email} from ${ip}`;
      const { value, output, warnings } = await captureConsole(() => endpointLogin(user.email, PASSWORD, ip));
      expect(value).toEqual({ location: UNIFORM_FAILURE, sessionCookie: null });
      expect(warnings).toContainEqual(["[login]", { event: "login.throttle_failed", error: "P1001" }]);
      expect(output).not.toContain(user.email);
      expect(output).not.toContain(ip);
      expect(output).not.toContain("connection to db lost");
      expect(output).not.toContain("Configuration");
    });

    it("14. verification failure: uniform refusal, the reservation stays counted, only the code is logged", async () => {
      const user = await makeUser("verify-fails");
      const ip = uniqueIp();
      state.faults.userRead = true;
      state.faults.message = `timeout reading ${user.email}`;
      const { value, output, warnings } = await captureConsole(() => endpointLogin(user.email, PASSWORD, ip));
      state.faults.userRead = false;
      expect(value).toEqual({ location: UNIFORM_FAILURE, sessionCookie: null });
      expect(warnings).toContainEqual(["[login]", { event: "login.verify_failed", error: "P1001" }]);
      expect(output).not.toContain(user.email);
      expect(await countedRows(user.email, ip)).toBe(1);
    });

    it("15. release failure after a correct password: the login still succeeds; the row stays counted until it expires", async () => {
      const user = await makeUser("release-fails");
      const ip = uniqueIp();
      state.faults.release = true;
      const { value, warnings } = await captureConsole(() => endpointLogin(user.email, PASSWORD, ip));
      state.faults.release = false;
      expect(value.sessionCookie).not.toBeNull();
      expect(warnings).toContainEqual(["[login]", { event: "login.reservation_release_failed", error: "P1001" }]);
      expect(await countedRows(user.email, ip)).toBe(1);
    });

    it("16. across the refusal paths, no submitted email, IP, password or key digest reaches the console", async () => {
      const user = await makeUser("log-scan");
      const ip = uniqueIp();
      const unknown = uniqueEmail("log-scan-unknown");
      const keys = loginThrottleKeys(user.email, ip);
      const { output } = await captureConsole(async () => {
        await endpointLogin(unknown, "Unknown-Passw0rd", ip);
        for (let i = 0; i < LOGIN_PAIR_LIMIT + 1; i += 1) await endpointLogin(user.email, WRONG, ip);
        await actionLogin(user.email, WRONG, ip);
      });
      expect(output).toContain("login.throttled");
      for (const secret of [user.email, unknown, ip, WRONG, "Unknown-Passw0rd", keys.account, keys.ip!]) {
        expect(output).not.toContain(secret);
      }
    });

    it("17. missing and inactive accounts each run exactly one same-cost bcrypt compare (structural; no wall-clock claim)", async () => {
      const inactive = await makeUser("dummy-inactive", { active: false });
      let before = state.compareCalls;
      expect(await authorize(uniqueEmail("dummy-missing"), PASSWORD, uniqueIp())).toBeNull();
      expect(state.compareCalls - before).toBe(1);
      before = state.compareCalls;
      expect(await authorize(inactive.email, PASSWORD, uniqueIp())).toBeNull();
      expect(state.compareCalls - before).toBe(1);
    });
  });

  describe("login action: pre-sign-in lookup boundary and preserved redirects", () => {
    it("18. the user lookup failing returns the uniform error, checks no password, counts nothing, logs only the code", async () => {
      const user = await makeUser("preauth-user");
      const ip = uniqueIp();
      state.faults.userRead = true;
      state.faults.message = `lookup failed for ${user.email}`;
      const before = state.compareCalls;
      const { value, output, warnings } = await captureConsole(() => actionLogin(user.email, PASSWORD, ip));
      state.faults.userRead = false;
      expect(value).toEqual({ result: { error: "invalidCredentials" }, redirect: null, sessionCookie: null });
      expect(state.compareCalls).toBe(before);
      expect(await countedRows(user.email)).toBe(0);
      expect(warnings).toEqual([["[login]", { event: "login.preauth_lookup_failed", error: "P1001" }]]);
      expect(output).not.toContain(user.email);
    });

    it("18b. a landing-query failure (the membership lookup) is caught by the same boundary", async () => {
      const org = await newOrganization();
      await runAction(uniqueIp(), () => acceptInvitation("es", {}, form({ token: org.token, password: PASSWORD })));
      state.faults.membershipRead = true;
      const { value, warnings } = await captureConsole(() => actionLogin(org.email, PASSWORD, uniqueIp()));
      state.faults.membershipRead = false;
      expect(value).toEqual({ result: { error: "invalidCredentials" }, redirect: null, sessionCookie: null });
      expect(warnings).toEqual([["[login]", { event: "login.preauth_lookup_failed", error: "P1001" }]]);
      expect(await countedRows(org.email)).toBe(0);
    });

    it("19. successful logins still redirect with the session cookie: staff → /dashboard, student → /portal, callbackUrl honoured", async () => {
      const org = await newOrganization();
      await runAction(uniqueIp(), () => acceptInvitation("es", {}, form({ token: org.token, password: PASSWORD })));
      const owner = await actionLogin(org.email, PASSWORD, uniqueIp());
      expect(owner.redirect).toMatch(/\/en\/dashboard$/);
      expect(owner.sessionCookie).not.toBeNull();

      const studentEmail = uniqueEmail("student");
      const signedUp = await runAction(uniqueIp(), () =>
        signup(
          org.slug,
          {},
          form({ firstName: "Real", lastName: `Student${n}`, phone: "88880000", email: studentEmail, homeAcademySlug: org.academySlug, currentBelt: "WHITE", currentStripes: "0", password: PASSWORD }),
        ),
      );
      expect(signedUp.result, JSON.stringify(signedUp.result)).toMatchObject({ ok: true });
      const ownerRow = await prisma.user.findUniqueOrThrow({ where: { email: org.email } });
      const studentUser = await prisma.user.findUniqueOrThrow({ where: { email: studentEmail } });
      const student = await prisma.student.findFirstOrThrow({ where: { userId: studentUser.id } });
      state.session = { user: { id: ownerRow.id }, activeOrganizationId: org.organizationId };
      await approveStudent(org.organizationId, {}, form({ studentId: student.id }));
      state.session = null;

      const portal = await actionLogin(studentEmail, PASSWORD, uniqueIp());
      expect(portal.redirect).toMatch(/\/en\/portal$/);
      expect(portal.sessionCookie).not.toBeNull();

      const withCallback = await actionLogin(org.email, PASSWORD, uniqueIp(), "/en/students");
      expect(withCallback.redirect).toMatch(/\/en\/students$/);
      expect(withCallback.sessionCookie).not.toBeNull();
    });
  });

  describe("invitation acceptance", () => {
    it("20. an invalid token is still `invalidToken`; nothing is signed in", async () => {
      const outcome = await runAction(uniqueIp(), () => acceptInvitation("es", {}, form({ token: "not-a-real-token", password: PASSWORD })));
      expect(outcome).toEqual({ result: { error: "invalidToken" }, redirect: null, sessionCookie: null });
    });

    it("21. an Owner acceptance that signs in still lands on /onboarding with a session; a staff invitee on /dashboard", async () => {
      const org = await newOrganization();
      const owner = await runAction(uniqueIp(), () => acceptInvitation("es", {}, form({ token: org.token, password: PASSWORD })));
      expect(owner.redirect).toMatch(/\/es\/onboarding$/);
      expect(owner.sessionCookie).not.toBeNull();

      const ownerRow = await prisma.user.findUniqueOrThrow({ where: { email: org.email } });
      state.session = { user: { id: ownerRow.id }, activeOrganizationId: org.organizationId };
      const coachEmail = uniqueEmail("coach");
      const invited = await inviteStaff(org.organizationId, {}, form({ email: coachEmail, role: "INSTRUCTOR", academyIds: org.academyId }));
      state.session = null;
      expect(invited, JSON.stringify(invited)).toMatchObject({ ok: true });
      const coachToken = new URL(invited.invitationLink!).searchParams.get("token")!;
      const coach = await runAction(uniqueIp(), () => acceptInvitation("es", {}, form({ token: coachToken, password: PASSWORD })));
      expect(coach.redirect).toMatch(/\/es\/dashboard$/);
      expect(coach.sessionCookie).not.toBeNull();
    });

    it("22. throttled auto sign-in AFTER acceptance commits: redirect to /login, invitation consumed, password set, no session", async () => {
      const org = await newOrganization();
      const ip = uniqueIp();
      await seedRows(org.email, ip, LOGIN_PAIR_LIMIT);
      const outcome = await runAction(ip, () => acceptInvitation("es", {}, form({ token: org.token, password: PASSWORD })));
      expect(outcome).toEqual({ result: undefined, redirect: "/es/login", sessionCookie: null });

      const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: org.email } });
      expect(invitation.usedAt).not.toBeNull();
      // The chosen password works once the person is allowed (here: from another IP).
      expect((await endpointLogin(org.email, PASSWORD, uniqueIp())).sessionCookie).not.toBeNull();
    });
  });

  describe("PR #134 preserved", () => {
    it("23. a login that recovered after throttling carries the account's current credentials version", async () => {
      const user = await makeUser("cv");
      await prisma.user.update({ where: { id: user.id }, data: { credentialsVersion: 3 } });
      const ip = uniqueIp();
      await seedRows(user.email, ip, LOGIN_PAIR_LIMIT, 16 * 60 * 1000);
      const { sessionCookie } = await endpointLogin(user.email, PASSWORD, ip);
      const token = await decode({ token: sessionCookie!, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE });
      expect(token?.cv).toBe(3);
      expect(token?.id).toBe(user.id);
    });
  });
});
