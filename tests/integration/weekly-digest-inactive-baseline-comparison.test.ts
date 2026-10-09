import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { ResendClient } from "../../src/lib/notifications/email-channel";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1/§4 (PR 4, review fix): a real before/after equivalence proof for
 * the digest's INACTIVE path, not a fragment assertion like `toContain("overdue")` (which proves the word
 * exists, never that the two implementations produce the same output).
 *
 * What is actually compared, precisely: the real pre-PR4 `sendWeeklyDigestForAcademy` (git-extracted from
 * `main` at PR 3's own merge commit, BASELINE_REF) wired to its OWN contemporaneous `dispatch.ts` /
 * `templates.ts` / `messages/{en,es}.json` — ALSO git-extracted at BASELINE_REF, not the current ones — against
 * the current, unmodified `sendWeeklyDigestForAcademy` wired to the current, real dispatch/templates/messages.
 * Both chains run against the SAME fixture rows under the SAME frozen instant.
 *
 * Review fix: an earlier version of this test extracted only `weekly-digest.ts` and let it call through to
 * `@/lib/notifications/dispatch` → `@/lib/notifications/templates`, i.e. the CURRENT templates module and
 * CURRENT message catalogs — both of which this PR changed (new `ledgerActive` branch, new `bodyLedger`/
 * `unknownSuffix` keys). Since BOTH the baseline and current send went through that one shared current
 * templates module, an accidental change to the UNCHANGED legacy wording/interpolation inside it would have
 * altered both outputs identically and never shown up as a difference — the comparison would keep passing
 * through a real regression. Fixed by also git-extracting `dispatch.ts`/`templates.ts`/the message JSON files
 * at BASELINE_REF into their own throwaway sibling files, with each sibling's own import of the next one in
 * the chain narrowly rewritten to point at its sibling instead of the real (current) module — so the baseline
 * chain is wired end-to-end to BASELINE_REF's code, genuinely independent of the current templates/messages.
 * The CURRENT path is untouched: `CurrentSend` still comes straight from the real `src/lib/notifications/
 * weekly-digest.ts`, which still imports the real `@/lib/notifications/dispatch` unmodified.
 *
 * `git diff BASELINE_REF HEAD -- <every file list-overdue/retention/recipients/email-channel/platform-lookups/
 * context/i18n-routing/notifications-types/prisma-schema touch>` is empty (confirmed before writing this file)
 * — every OTHER link in the chain is genuinely unchanged since BASELINE_REF, so reusing the current, real
 * versions of those (rather than extracting them too) is not a shortcut that could hide a regression; only
 * `weekly-digest.ts`, `dispatch.ts`, `templates.ts`, and the two message files needed extracting at all.
 *
 * Deterministic time: `sendWeeklyDigestForAcademy` has no injectable `now` (same constraint the dashboard
 * baseline test faced for its own page), so real wall-clock time is frozen via `vi.useFakeTimers()` +
 * `vi.setSystemTime(FROZEN_NOW)` for BOTH calls, against the SAME fixture rows, so the two implementations see
 * identical "today" and identical data. Mocked delivery: a `RecordingResendClient` stands in for Resend (no
 * network call, no real email) — one fresh instance per call, so the comparison is between what each
 * implementation WOULD have sent, not a side effect of one send affecting the other (this function performs no
 * writes besides the recipient email itself; see its own doc comment on being EMAIL-ONLY, no Notification row).
 *
 * Normalization: NONE applied, and none was found necessary. Unlike the dashboard's React-rendered HTML (which
 * needed React's own `useId()`-generated ids normalized away), this digest's output is plain interpolated text
 * with no per-render randomness — the `from`/`to`/`subject`/`html` of each call are compared for exact,
 * byte-for-byte equality. The digest's counts (attendance, inactivity, and — on this legacy path — overdue
 * payments) ARE financial-status content, even though none of them is a currency amount: `overduePayments` is
 * a direct statement about which students owe money. Nothing here is normalized away, on either side.
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "5e259e0f62c57e00e144ab92866eb530cc7d13e1";

const DIGEST_PATH = "src/lib/notifications/weekly-digest.ts";
const DIGEST_BASELINE_FILE = "src/lib/notifications/__pr4_baseline_5e259e0_weekly-digest.ts";
const DISPATCH_PATH = "src/lib/notifications/dispatch.ts";
const DISPATCH_BASELINE_FILE = "src/lib/notifications/__pr4_baseline_5e259e0_dispatch.ts";
const TEMPLATES_PATH = "src/lib/notifications/templates.ts";
const TEMPLATES_BASELINE_FILE = "src/lib/notifications/__pr4_baseline_5e259e0_templates.ts";
const EN_MESSAGES_PATH = "messages/en.json";
const EN_MESSAGES_BASELINE_FILE = "messages/__pr4_baseline_5e259e0_en.json";
const ES_MESSAGES_PATH = "messages/es.json";
const ES_MESSAGES_BASELINE_FILE = "messages/__pr4_baseline_5e259e0_es.json";

const BASELINE_FILES = [DIGEST_BASELINE_FILE, DISPATCH_BASELINE_FILE, TEMPLATES_BASELINE_FILE, EN_MESSAGES_BASELINE_FILE, ES_MESSAGES_BASELINE_FILE];

function ensureCommitFetched(ref: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: "ignore" });
  }
}

function extractBaseline(gitPath: string): string {
  return execFileSync("git", ["show", `${BASELINE_REF}:${gitPath}`], { encoding: "utf8" });
}

function removeIfExists(p: string) {
  if (existsSync(p)) rmSync(p);
}

type BaselineModule = { sendWeeklyDigestForAcademy: (academyId: string, client: ResendClient) => Promise<unknown> };
let BaselineSend: BaselineModule["sendWeeklyDigestForAcademy"];
let CurrentSend: BaselineModule["sendWeeklyDigestForAcademy"];

/** Records every (from, to, subject, html) tuple — no network call, no real email. */
class RecordingResendClient implements ResendClient {
  calls: Array<{ from: string; to: string; subject: string; html: string }> = [];
  emails = {
    send: async (params: { from: string; to: string; subject: string; html: string }) => {
      this.calls.push(params);
      return { data: { id: "fake-id" }, error: null };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00"); // day 15 — past the legacy day-5 overdue cutoff
let org: Fixture;
let planId: string;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);

  // The message catalogs: pure data, no rewrite needed.
  writeFileSync(EN_MESSAGES_BASELINE_FILE, extractBaseline(EN_MESSAGES_PATH), "utf8");
  writeFileSync(ES_MESSAGES_BASELINE_FILE, extractBaseline(ES_MESSAGES_PATH), "utf8");

  // templates.ts: narrowly rewrite its two message-catalog imports to the baseline siblings above — same
  // relative depth (`src/lib/notifications/` → `../../../messages/`), so only the filename changes.
  const templatesContent = extractBaseline(TEMPLATES_PATH);
  if (!templatesContent.includes("export function renderNotificationMessage")) {
    throw new Error(`Baseline extraction for ${TEMPLATES_PATH} looks wrong — first 200 chars:\n${templatesContent.slice(0, 200)}`);
  }
  const rewrittenTemplates = templatesContent
    .replace('"../../../messages/es.json"', '"../../../messages/__pr4_baseline_5e259e0_es.json"')
    .replace('"../../../messages/en.json"', '"../../../messages/__pr4_baseline_5e259e0_en.json"');
  if (rewrittenTemplates === templatesContent) {
    throw new Error("Expected to rewrite the baseline templates.ts's message-catalog imports, but no replacement occurred.");
  }
  writeFileSync(TEMPLATES_BASELINE_FILE, rewrittenTemplates, "utf8");

  // dispatch.ts: narrowly rewrite its one import of templates.ts to the baseline sibling above.
  const dispatchContent = extractBaseline(DISPATCH_PATH);
  if (!dispatchContent.includes("export async function dispatchToRecipients")) {
    throw new Error(`Baseline extraction for ${DISPATCH_PATH} looks wrong — first 200 chars:\n${dispatchContent.slice(0, 200)}`);
  }
  const rewrittenDispatch = dispatchContent.replace(
    '"@/lib/notifications/templates"',
    '"./__pr4_baseline_5e259e0_templates"',
  );
  if (rewrittenDispatch === dispatchContent) {
    throw new Error("Expected to rewrite the baseline dispatch.ts's templates import, but no replacement occurred.");
  }
  writeFileSync(DISPATCH_BASELINE_FILE, rewrittenDispatch, "utf8");

  // weekly-digest.ts: narrowly rewrite its one import of dispatch.ts to the baseline sibling above. Every
  // other import stays untouched (list-overdue/retention/recipients/email-channel/platform-lookups/context
  // are all confirmed unchanged since BASELINE_REF — see this file's own header comment).
  const digestContent = extractBaseline(DIGEST_PATH);
  if (!digestContent.includes("export async function sendWeeklyDigestForAcademy")) {
    throw new Error(`Baseline extraction for ${DIGEST_PATH} looks wrong — first 200 chars:\n${digestContent.slice(0, 200)}`);
  }
  const rewrittenDigest = digestContent.replace(
    '"@/lib/notifications/dispatch"',
    '"./__pr4_baseline_5e259e0_dispatch"',
  );
  if (rewrittenDigest === digestContent) {
    throw new Error("Expected to rewrite the baseline weekly-digest.ts's dispatch import, but no replacement occurred.");
  }
  writeFileSync(DIGEST_BASELINE_FILE, rewrittenDigest, "utf8");

  // Non-literal specifier on purpose: the baseline file doesn't exist on disk until the writes above run, so a
  // literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically resolve a module
  // that is only ever materialized at test runtime — same reasoning the dashboard baseline test documents.
  const digestBaselineImport = "../../" + DIGEST_BASELINE_FILE.replace(/\.ts$/, "");
  ({ sendWeeklyDigestForAcademy: BaselineSend } = await import(/* @vite-ignore */ digestBaselineImport));
  ({ sendWeeklyDigestForAcademy: CurrentSend } = await import("../../src/lib/notifications/weekly-digest"));

  org = await makeAccountingOrg("CUMULATIVE", "wd-baseline");
  // Schema default locale is "es" — forced to "en" so this file's body-text assertions are deterministic
  // regardless of that default (same fix `weekly-digest-ledger.test.ts`'s own `makeOrg` helper applies).
  await prisma.user.update({ where: { id: org.admin.id }, data: { locale: "en" } });
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId: org.academy.id, name: `WD baseline plan` } });
  planId = plan.id;

  async function newStudent(label: string) {
    return prisma.student.create({
      data: {
        organizationId: org.org.id, homeAcademyId: org.academy.id, firstName: "WDBaseline", lastName: label, phone: "00000000",
        email: `wd-baseline-${label}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `wd-baseline-${label}`, status: "ACTIVE",
      },
    });
  }
  async function checkin(studentId: string, daysAgo: number) {
    const occurredAt = new Date(FROZEN_NOW.getTime() - daysAgo * 86_400_000);
    await prisma.attendanceRecord.create({
      data: { organizationId: org.org.id, academyId: org.academy.id, studentId, type: "CHECKIN", source: "KIOSK", occurredAt, date: occurredAt },
    });
  }
  async function paidCurrentMonth(studentId: string) {
    await prisma.paymentPeriod.create({
      data: { studentId, academyId: org.academy.id, organizationId: org.org.id, year: 2030, month: 6, planId, status: "PAID", amount: "100.00", currency: "USD", recordedById: org.admin.id },
    });
  }

  // Meaningful nonzero data on all three legacy counts at once, same shape `weekly-digest.test.ts`'s own A1/A4/A5
  // fixtures already establish: recent attendance + paid (neither inactive nor overdue), old attendance + paid
  // (inactive only), recent attendance + no PaymentPeriod row at all (overdue, and still counts toward attendance).
  const paidRecent = await newStudent("paid-recent");
  await checkin(paidRecent.id, 1);
  await paidCurrentMonth(paidRecent.id);

  const inactiveStudent = await newStudent("inactive");
  await checkin(inactiveStudent.id, 45);
  await paidCurrentMonth(inactiveStudent.id);

  const overdueStudent = await newStudent("overdue");
  await checkin(overdueStudent.id, 2);
  // No PaymentPeriod row — the legacy `isOverdue` rule reports OVERDUE automatically once `today.day > 5`.
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  for (const f of BASELINE_FILES) removeIfExists(f);
  if (!org) return;
  // paymentPeriod/paymentPlan aren't covered by makeAccountingOrg's own drop() (no prior caller of this fixture
  // ever created legacy PaymentPeriod rows) — deleted here first, before drop()'s own student/academy delete,
  // to avoid a foreign-key violation.
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
  await org.drop();
}, 60_000);

describe("sendWeeklyDigestForAcademy: inactive-path render EQUIVALENCE against the pre-PR4 baseline (main@5e259e0)", () => {
  it("REQUIRED: current inactive-path output is byte-identical to the real pre-PR4 implementation — including its own contemporaneous templates/messages, not the current ones — under frozen time and real meaningful nonzero fixtures", async () => {
    const baselineClient = new RecordingResendClient();
    await BaselineSend(org.academy.id, baselineClient);
    const currentClient = new RecordingResendClient();
    await CurrentSend(org.academy.id, currentClient);

    // Non-vacuous: real, meaningful nonzero content on all three legacy counts — not an empty-shell digest.
    expect(baselineClient.calls.length).toBeGreaterThan(0);
    const baselineBody = baselineClient.calls[0]!.html;
    expect(baselineBody).toContain("2"); // attendanceCount: paidRecent + overdueStudent
    expect(baselineBody).toContain("1 students inactive"); // inactiveCount: inactiveStudent only
    expect(baselineBody).toContain("1 overdue payments"); // overduePayments: overdueStudent only — financial-status content

    expect(currentClient.calls).toEqual(baselineClient.calls);
  });
});
