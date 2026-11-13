import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubProductionEmailPolicy, stubStagingEmailPolicy } from "../helpers/email-policy";

/**
 * docs/EMAIL_RECIPIENT_POLICY.md — the fail-closed recipient policy, exercised through BOTH real send paths
 * (sendTransactionalEmail, and EmailChannel through dispatchNotification), starting from the actual staging deployment's
 * configuration. Resend is replaced: constructing a client or calling send is recorded, and nothing leaves the machine.
 */
const providerSend = vi.fn(async () => ({ data: { id: "msg_1" }, error: null }));
const clientsConstructed = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => (providerSend as (...a: unknown[]) => unknown)(...args) };
    constructor() {
      clientsConstructed();
    }
  },
}));

const { sendTransactionalEmail } = await import("../../src/lib/email/send-transactional-email");
const { EmailChannel } = await import("../../src/lib/notifications/email-channel");
const { dispatchNotification } = await import("../../src/lib/notifications/dispatch");
const { resolveEmailPolicy, checkRecipient, emailPolicyStatus, MAX_ALLOWLIST_ENTRIES } = await import("../../src/lib/email/recipient-policy");
const { GET } = await import("../../src/app/api/health/email-policy/route");

const LISTED = "listed@example.test";
const OUTSIDER = "outsider@example.test";
const SECRET = "test-only-status-secret";

beforeEach(() => {
  providerSend.mockClear();
  clientsConstructed.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("RESEND_API_KEY", "re_test_only_key");
  vi.stubEnv("EMAIL_FROM", "MATROOM <noreply@example.test>");
  vi.stubEnv("CRON_SECRET", SECRET);
  stubStagingEmailPolicy(LISTED);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Sends to `to` through both real paths; returns each path's outcome and what the provider saw. */
async function sendBothPaths(to: string) {
  const transactional = await sendTransactionalEmail(to, "subject", ["line"]);
  const channelClient = { emails: { send: vi.fn(async () => ({ data: { id: "msg_2" }, error: null })) } };
  const channel = new EmailChannel(channelClient);
  const direct = await channel.send({ userId: "u1", email: to, locale: "en", organizationId: "o1" }, { type: "NEW_SIGNUP", title: "t", body: "b" });
  const counts = await dispatchNotification(
    [{ userId: "u1", email: to, locale: "en", organizationId: "o1" }],
    { type: "NEW_SIGNUP", title: "t", body: "b" },
    [channel],
  );
  return { transactional, direct, counts, channelSends: channelClient.emails.send.mock.calls.length };
}

function expectBlockedEverywhere(result: Awaited<ReturnType<typeof sendBothPaths>>) {
  expect(result.transactional).toMatchObject({ success: false, outcome: "blocked" });
  expect(result.direct).toMatchObject({ success: false, outcome: "blocked" });
  // A blocked message is a failed delivery: never counted as sent.
  expect(result.counts).toEqual({ attempted: 1, sent: 0, failed: 1 });
  expect(result.channelSends).toBe(0);
  expect(providerSend).not.toHaveBeenCalled();
  expect(clientsConstructed).not.toHaveBeenCalled();
}

describe("the actual staging configuration: VERCEL_ENV=production, EMAIL_DELIVERY_MODE=allowlist", () => {
  it("unchanged: the listed address sends through both paths (case-insensitive); any other address is blocked", async () => {
    const listed = await sendBothPaths("Listed@Example.TEST");
    expect(listed.transactional).toEqual({ success: true, outcome: "accepted" });
    expect(listed.direct).toEqual({ success: true });
    expect(listed.counts).toEqual({ attempted: 1, sent: 1, failed: 0 });

    providerSend.mockClear();
    clientsConstructed.mockClear();
    expectBlockedEverywhere(await sendBothPaths(OUTSIDER));
  });

  const MUTATIONS: Array<[string, Record<string, string | undefined>, string]> = [
    ["allowlist removed", { EMAIL_RECIPIENT_ALLOWLIST: undefined }, "allowlist_missing"],
    ["allowlist empty", { EMAIL_RECIPIENT_ALLOWLIST: "" }, "allowlist_missing"],
    ["allowlist only spaces", { EMAIL_RECIPIENT_ALLOWLIST: "   " }, "allowlist_missing"],
    ["allowlist a lone comma", { EMAIL_RECIPIENT_ALLOWLIST: "," }, "allowlist_invalid"],
    ["allowlist with a trailing comma", { EMAIL_RECIPIENT_ALLOWLIST: `${LISTED},` }, "allowlist_invalid"],
    ["allowlist a bare domain", { EMAIL_RECIPIENT_ALLOWLIST: "example.test" }, "allowlist_invalid"],
    ["allowlist a wildcard", { EMAIL_RECIPIENT_ALLOWLIST: "*@example.test" }, "allowlist_invalid"],
    ["allowlist entries separated by a space", { EMAIL_RECIPIENT_ALLOWLIST: `${LISTED} b@example.test` }, "allowlist_invalid"],
    ["allowlist entries separated by a semicolon", { EMAIL_RECIPIENT_ALLOWLIST: `${LISTED};b@example.test` }, "allowlist_invalid"],
    ["allowlist with a display name", { EMAIL_RECIPIENT_ALLOWLIST: `Owner <${LISTED}>` }, "allowlist_invalid"],
    ["one valid and one invalid entry", { EMAIL_RECIPIENT_ALLOWLIST: `${LISTED},nope` }, "allowlist_invalid"],
    [
      `${MAX_ALLOWLIST_ENTRIES + 1} entries`,
      { EMAIL_RECIPIENT_ALLOWLIST: [LISTED, ...Array.from({ length: MAX_ALLOWLIST_ENTRIES }, (_, i) => `u${i}@example.test`)].join(",") },
      "allowlist_invalid",
    ],
    ["mode removed", { EMAIL_DELIVERY_MODE: undefined }, "mode_invalid"],
    ["mode empty", { EMAIL_DELIVERY_MODE: "" }, "mode_invalid"],
    ["mode in a different case", { EMAIL_DELIVERY_MODE: "Allowlist" }, "mode_invalid"],
    ["mode misspelled", { EMAIL_DELIVERY_MODE: "allow-list" }, "mode_invalid"],
    ["mode and allowlist both removed", { EMAIL_DELIVERY_MODE: undefined, EMAIL_RECIPIENT_ALLOWLIST: undefined }, "mode_invalid"],
    ["mode switched to unrestricted, allowlist still set", { EMAIL_DELIVERY_MODE: "unrestricted" }, "mode_conflict"],
  ];

  for (const [name, change, reason] of MUTATIONS) {
    it(`REQUIRED ${name}: every send is blocked in both paths, including to the previously listed address (${reason})`, async () => {
      for (const [key, value] of Object.entries(change)) vi.stubEnv(key, value);
      expect(resolveEmailPolicy()).toEqual({ effective: "blocked_all", reason });
      expectBlockedEverywhere(await sendBothPaths(LISTED));
      expectBlockedEverywhere(await sendBothPaths(OUTSIDER));
    });
  }

  it("removing the allowlist never falls back to unrestricted sending", async () => {
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", undefined);
    expect(resolveEmailPolicy().effective).toBe("blocked_all");
    expectBlockedEverywhere(await sendBothPaths(OUTSIDER));
  });

  it("recipient strings that are not exactly one listed address are blocked", async () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k" with String#toLowerCase; it must not match a listed "k" address.
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", `${LISTED},kim@example.test`);
    for (const to of [`${LISTED}, ${OUTSIDER}`, `Owner <${LISTED}>`, ` ${LISTED}`, `${LISTED}\n`, `${LISTED}\r\nBcc: ${OUTSIDER}`, "Kim@example.test"]) {
      expect(checkRecipient(to), JSON.stringify(to)).toEqual({ allowed: false, reason: "not_allowlisted" });
    }
    expectBlockedEverywhere(await sendBothPaths(`${LISTED}, ${OUTSIDER}`));
  });

  it("DOCUMENTED LIMITATION: VERCEL_ENV=production cannot tell staging from production — mode unrestricted AND allowlist removed sends to anyone", async () => {
    // Two deliberate settings changes on staging. Either one alone is covered above and blocks every send. Only the
    // staging project's own configuration (verified by /api/health/email-policy) keeps it restricted.
    vi.stubEnv("EMAIL_DELIVERY_MODE", "unrestricted");
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", undefined);
    const result = await sendBothPaths(OUTSIDER);
    expect(result.transactional).toEqual({ success: true, outcome: "accepted" });
    expect(result.counts.sent).toBe(1);
  });
});

describe("production configuration: unrestricted, no allowlist", () => {
  it("sends to any address on a production-target deployment", async () => {
    stubProductionEmailPolicy();
    const result = await sendBothPaths(OUTSIDER);
    expect(result.transactional).toEqual({ success: true, outcome: "accepted" });
    expect(result.direct).toEqual({ success: true });
    expect(result.counts).toEqual({ attempted: 1, sent: 1, failed: 0 });
  });

  for (const target of [undefined, "preview", "development", "Production"]) {
    it(`unrestricted on VERCEL_ENV=${String(target)} blocks every send`, async () => {
      stubProductionEmailPolicy();
      vi.stubEnv("VERCEL_ENV", target);
      expect(resolveEmailPolicy()).toEqual({ effective: "blocked_all", reason: "unrestricted_outside_production" });
      expectBlockedEverywhere(await sendBothPaths(OUTSIDER));
    });
  }

  it("unrestricted with an allowlist present (even empty) blocks every send", async () => {
    stubProductionEmailPolicy();
    for (const list of ["", OUTSIDER]) {
      vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", list);
      expect(resolveEmailPolicy()).toEqual({ effective: "blocked_all", reason: "mode_conflict" });
      expectBlockedEverywhere(await sendBothPaths(OUTSIDER));
    }
  });
});

describe("policy status (no addresses, secrets or raw settings)", () => {
  const forbidden = (allowlist: string) => ["@", SECRET, "re_test_only_key", "noreply", "example.test", ...allowlist.split(",").filter(Boolean)];

  it("staging: allowlist effective, count and a fingerprint keyed with the secret that matches an independent computation", () => {
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", ` B@Example.test,${LISTED} ,b@example.test`);
    const status = emailPolicyStatus(SECRET);
    const expected = createHmac("sha256", SECRET).update(["b@example.test", LISTED].join("\n")).digest("hex");
    expect(status).toEqual({
      mode: "allowlist",
      effective: "allowlist",
      reason: null,
      deploymentTarget: "production",
      allowlistCount: 2,
      allowlistFingerprint: expected,
      providerKeyPresent: true,
      senderConfigured: true,
    });
    expect(emailPolicyStatus("another-secret").allowlistFingerprint).not.toBe(expected);
    const body = JSON.stringify(status);
    for (const text of forbidden(`${LISTED},b@example.test`)) expect(body).not.toContain(text);
  });

  it("production: unrestricted, no count, no fingerprint", () => {
    stubProductionEmailPolicy();
    expect(emailPolicyStatus(SECRET)).toMatchObject({ mode: "unrestricted", effective: "unrestricted", reason: null, allowlistCount: null, allowlistFingerprint: null });
  });

  it("every blocking configuration reports blocked_all with its reason and never echoes the raw value", () => {
    const cases: Array<[Record<string, string | undefined>, string, string]> = [
      [{ EMAIL_DELIVERY_MODE: "Allow list secret-ish" }, "invalid", "mode_invalid"],
      [{ EMAIL_RECIPIENT_ALLOWLIST: undefined }, "allowlist", "allowlist_missing"],
      [{ EMAIL_RECIPIENT_ALLOWLIST: `${LISTED},*@x.test` }, "allowlist", "allowlist_invalid"],
      [{ EMAIL_DELIVERY_MODE: "unrestricted" }, "unrestricted", "mode_conflict"],
      [{ EMAIL_DELIVERY_MODE: "unrestricted", EMAIL_RECIPIENT_ALLOWLIST: undefined, VERCEL_ENV: "preview" }, "unrestricted", "unrestricted_outside_production"],
    ];
    for (const [change, mode, reason] of cases) {
      stubStagingEmailPolicy(LISTED);
      for (const [key, value] of Object.entries(change)) vi.stubEnv(key, value);
      const status = emailPolicyStatus(SECRET);
      expect(status, reason).toMatchObject({ mode, effective: "blocked_all", reason, allowlistCount: null, allowlistFingerprint: null });
      const body = JSON.stringify(status);
      expect(body).not.toContain("secret-ish");
      expect(body).not.toContain("@");
    }
  });

  it("reports only whether the provider key and sender are present, never their values", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", undefined);
    vi.stubEnv("VERCEL_ENV", "something-else");
    expect(emailPolicyStatus(SECRET)).toMatchObject({ providerKeyPresent: false, senderConfigured: false, deploymentTarget: "other" });
  });
});

describe("GET /api/health/email-policy authentication", () => {
  const request = (authorization?: string) =>
    new Request("http://localhost/api/health/email-policy", authorization === undefined ? {} : { headers: { authorization } });

  for (const [name, header] of [
    ["no Authorization header", undefined],
    ["a wrong secret", "Bearer wrong-secret"],
    ["the secret without the Bearer scheme", SECRET],
    ["a lowercase scheme", `bearer ${SECRET}`],
    ["a longer secret", `Bearer ${SECRET}x`],
  ] as const) {
    it(`REQUIRED ${name} → 401 with no policy detail`, async () => {
      const response = await GET(request(header));
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ ok: false, error: "unauthorized" });
      expect(body).not.toContain("allowlist");
    });
  }

  it("the correct secret → 200 with the status only: no address, secret or key; no Resend client, no send", async () => {
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ mode: "allowlist", effective: "allowlist", allowlistCount: 1 });
    for (const text of ["@", SECRET, "re_test_only_key", "noreply", "example.test"]) expect(body).not.toContain(text);
    expect(clientsConstructed).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });
});

describe("static guard: no third send path", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("emails.send( is called only in the two gated functions, each after checkRecipient(", () => {
    const root = join(__dirname, "../../src");
    const callers = sourceFiles(root)
      .map((path) => ({ file: relative(root, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }))
      .filter(({ text }) => text.includes("emails.send("));
    expect(callers.map(({ file }) => file).sort()).toEqual(["lib/email/send-transactional-email.ts", "lib/notifications/email-channel.ts"]);
    for (const { file, text } of callers) {
      expect(text.split("emails.send(").length - 1, file).toBe(1);
      expect(text.indexOf("checkRecipient("), file).toBeGreaterThan(-1);
      expect(text.indexOf("checkRecipient("), file).toBeLessThan(text.indexOf("emails.send("));
    }
  });
});
