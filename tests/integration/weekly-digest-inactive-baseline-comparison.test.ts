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
 * exists, never that the two implementations produce the same output). Same git-extraction technique
 * `dashboard-page-inactive-baseline-comparison.test.ts` already established: the real pre-PR4 `weekly-digest.ts`
 * source, git-extracted from `main` at PR 3's own merge commit (BASELINE_REF, the pinned "pre-PR main" ref this
 * PR's own review feedback named), written to a throwaway sibling module and dynamically imported — never
 * reconstructed from memory or re-typed by hand.
 *
 * No import rewrite is needed here (unlike the dashboard baseline, which had to repoint one relative import
 * whose target changed shape): `git diff BASELINE_REF HEAD -- <every file weekly-digest.ts imports>` is empty —
 * confirmed before writing this file — so the baseline module's own `@/lib/...` imports resolve to the exact
 * same, unchanged current modules.
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
 * needed React's own `useId()`-generated ids normalized away), this digest's output is plain interpolated
 * text with no per-render randomness — the `from`/`to`/`subject`/`html` of each call are compared for exact,
 * byte-for-byte equality. This digest has no financial content at all (only attendance/inactivity/overdue
 * COUNTS, never a dollar amount), so the "never normalize financial content" instruction has nothing to
 * apply to here — stated explicitly rather than silently satisfied.
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "5e259e0f62c57e00e144ab92866eb530cc7d13e1";
const DIGEST_PATH = "src/lib/notifications/weekly-digest.ts";
const BASELINE_FILE = "src/lib/notifications/__pr4_baseline_5e259e0_weekly-digest.ts";

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
  const content = extractBaseline(DIGEST_PATH);
  if (!content.includes("export async function sendWeeklyDigestForAcademy")) {
    throw new Error(`Baseline extraction for ${DIGEST_PATH} looks wrong — first 200 chars:\n${content.slice(0, 200)}`);
  }
  writeFileSync(BASELINE_FILE, content, "utf8");

  // Non-literal specifier on purpose: the baseline file doesn't exist on disk until the write above runs, so a
  // literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically resolve a module
  // that is only ever materialized at test runtime — same reasoning the dashboard baseline test documents.
  const baselineImport = "../../" + BASELINE_FILE.replace(/\.ts$/, "");
  ({ sendWeeklyDigestForAcademy: BaselineSend } = await import(/* @vite-ignore */ baselineImport));
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
  removeIfExists(BASELINE_FILE);
  if (!org) return;
  // paymentPeriod/paymentPlan aren't covered by makeAccountingOrg's own drop() (no prior caller of this fixture
  // ever created legacy PaymentPeriod rows) — deleted here first, before drop()'s own student/academy delete,
  // to avoid a foreign-key violation.
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
  await org.drop();
}, 60_000);

describe("sendWeeklyDigestForAcademy: inactive-path render EQUIVALENCE against the pre-PR4 baseline (main@5e259e0)", () => {
  it("REQUIRED: current inactive-path output is byte-identical to the real pre-PR4 implementation, under frozen time and real meaningful nonzero fixtures", async () => {
    const baselineClient = new RecordingResendClient();
    await BaselineSend(org.academy.id, baselineClient);
    const currentClient = new RecordingResendClient();
    await CurrentSend(org.academy.id, currentClient);

    // Non-vacuous: real, meaningful nonzero content on all three legacy counts — not an empty-shell digest.
    expect(baselineClient.calls.length).toBeGreaterThan(0);
    const baselineBody = baselineClient.calls[0]!.html;
    expect(baselineBody).toContain("2"); // attendanceCount: paidRecent + overdueStudent
    expect(baselineBody).toContain("1 students inactive"); // inactiveCount: inactiveStudent only
    expect(baselineBody).toContain("1 overdue payments"); // overduePayments: overdueStudent only

    expect(currentClient.calls).toEqual(baselineClient.calls);
  });
});
