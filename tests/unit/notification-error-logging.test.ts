import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thrown-exception logging in the notification paths: dispatchNotification's "channel threw" handler, the
 * notifyNewSignup / notifyEligibilityReached catch-alls, and fireAndForget. Each injects an error whose message, stack,
 * meta and cause carry a fabricated address, token, link and query parameter, then inspects EVERY console argument
 * (util.inspect, so an Error's non-enumerable message/stack count) — only the fixed event, allow-listed job name and
 * error code may appear. Behavior (counts, swallowing, after() scheduling) is asserted alongside.
 */
const findUnique = vi.fn();
const resolveStaffRecipients = vi.fn();
const after = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { student: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
vi.mock("@/lib/notifications/recipients", () => ({
  resolveStaffRecipients: (...a: unknown[]) => resolveStaffRecipients(...a),
}));
vi.mock("next/server", () => ({ after: (...a: unknown[]) => after(...a) }));

const { dispatchNotification } = await import("../../src/lib/notifications/dispatch");
const { notifyNewSignup } = await import("../../src/lib/notifications/notify-new-signup");
const { notifyEligibilityReached } = await import("../../src/lib/notifications/notify-eligibility");
const { fireAndForget } = await import("../../src/lib/notifications/fire-and-forget");
import type { NotificationChannel, Recipient } from "../../src/lib/notifications/types";

const ADDRESS = "synth.victim.q7@example.test";
const TOKEN = "SYNTH-TOKEN-Zx81Kq";
const LINK = `https://synthetic.example.test/accept-invitation?token=${TOKEN}`;
const DB_PARAM = "SYNTH-DB-PARAM-Hn42";
const SECRETS = [ADDRESS, TOKEN, LINK, DB_PARAM];

function secretError(extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`cannot deliver to ${ADDRESS} via ${LINK} (where id = ${DB_PARAM})`), {
    meta: { target: [ADDRESS], args: [DB_PARAM] },
    cause: new Error(`request body ${TOKEN}`),
    ...extra,
  });
}

let calls: unknown[][] = [];
beforeEach(() => {
  calls = [];
  for (const level of ["error", "warn", "info", "log", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void calls.push(args));
  }
  findUnique.mockReset();
  resolveStaffRecipients.mockReset();
  after.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function expectOnly(expected: unknown[][]) {
  const rendered = inspect(calls, { depth: null, showHidden: true });
  for (const secret of SECRETS) expect(rendered, `console contains ${secret}`).not.toContain(secret);
  expect(calls).toEqual(expected);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const recipients: Recipient[] = ["u1", "u2"].map((userId) => ({
  userId,
  email: ADDRESS,
  locale: "en",
  organizationId: "org-1",
}));
const message = { type: "NEW_SIGNUP" as const, title: `t ${TOKEN}`, body: `b ${LINK}` };

describe("dispatchNotification — channel threw", () => {
  it("logs the fixed event, type and error code only; one throwing channel still counts as failed and never blocks the other", async () => {
    const ok: NotificationChannel = { supportsInboundReplies: false, send: vi.fn(async () => ({ success: true })) };
    const throwing: NotificationChannel = {
      supportsInboundReplies: false,
      send: vi.fn(async () => {
        throw secretError();
      }),
    };
    expect(await dispatchNotification(recipients, message, [throwing, ok])).toEqual({ attempted: 4, sent: 2, failed: 2 });
    expect(ok.send).toHaveBeenCalledTimes(2);
    const line = ["notification channel threw", { type: "NEW_SIGNUP", error: "unrecognized_error" }];
    expectOnly([line, line]);
  });

  it("keeps a Prisma error code (and nothing else from the error)", async () => {
    const throwing: NotificationChannel = {
      supportsInboundReplies: false,
      send: async () => {
        throw secretError({ code: "P2002", name: "PrismaClientKnownRequestError" });
      },
    };
    expect(await dispatchNotification([recipients[0]], message, [throwing])).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expectOnly([["notification channel threw", { type: "NEW_SIGNUP", error: "P2002" }]]);
  });
});

describe("notification catch-alls", () => {
  it("notifyNewSignup swallows a lookup failure and logs only the fixed event and error code", async () => {
    findUnique.mockRejectedValue(secretError());
    await expect(notifyNewSignup("s1", "org-1", [])).resolves.toBeUndefined();
    expectOnly([["notifyNewSignup failed (non-fatal)", { error: "unrecognized_error" }]]);
  });

  it("notifyEligibilityReached swallows a recipient-resolution failure and logs only the fixed event and error code", async () => {
    findUnique.mockResolvedValue({
      firstName: "Synth",
      lastName: "Student",
      currentStripes: 1,
      homeAcademyId: "a1",
      currentRank: { labelEs: "Blanco", labelEn: "White" },
    });
    resolveStaffRecipients.mockRejectedValue(secretError({ code: "P1001" }));
    await expect(notifyEligibilityReached("s1", "org-1", "STRIPE_THRESHOLD", [])).resolves.toBeUndefined();
    expectOnly([["notifyEligibilityReached failed (non-fatal)", { error: "P1001" }]]);
  });
});

describe("fireAndForget", () => {
  it("registers the work with after() (not run inline) and logs a rejection as the fixed event, job name and code", async () => {
    const work = vi.fn(() => Promise.reject(secretError({ name: "TypeError" })));
    expect(fireAndForget("notifyNewSignup", work)).toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(work).toHaveBeenCalledTimes(1);
    expectOnly([["background job failed (non-fatal)", { job: "notifyNewSignup", error: "TypeError" }]]);
  });

  it("falls back to running the work directly when after() throws outside a request scope", async () => {
    after.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    const work = vi.fn(() => Promise.reject(secretError()));
    expect(fireAndForget("notifyEligibilityReached", work)).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);
    await flush();
    expectOnly([["background job failed (non-fatal)", { job: "notifyEligibilityReached", error: "unrecognized_error" }]]);
  });

  it("never logs a caller-supplied label that is not on the allow-list", async () => {
    after.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    fireAndForget(`notify ${ADDRESS} ${LINK}` as never, () => Promise.reject(secretError()));
    await flush();
    expectOnly([["background job failed (non-fatal)", { job: "unrecognized_job", error: "unrecognized_error" }]]);
  });

  it("a successful job logs nothing", async () => {
    const work = vi.fn(() => Promise.resolve());
    fireAndForget("notifyNewSignup", work);
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(work).toHaveBeenCalledTimes(1);
    expectOnly([]);
  });
});
