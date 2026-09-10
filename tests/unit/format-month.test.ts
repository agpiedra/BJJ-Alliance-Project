import { afterEach, describe, expect, it } from "vitest";
import { formatMonthYear } from "@/lib/format-month";

/**
 * Regression test for Phase 6 final whole-branch review finding I-3: both
 * `students/[id]/page.tsx`'s payment-history table and `dashboard/page.tsx`'s
 * overdue-payments panel build a `Date.UTC(year, month - 1, 1)` marker and
 * used to format it via `Intl.DateTimeFormat` with NO explicit `timeZone` —
 * which renders in whatever timezone the server RUNTIME happens to be in,
 * not this synthetic marker's own UTC construction. Under
 * `TZ=America/Costa_Rica` (this app's fixed domain timezone, UTC-6), a
 * `{year: 2026, month: 1}` period rendered as "December 2025" instead of
 * "January 2026" — one month early.
 *
 * These tests mutate `process.env.TZ` directly (restored in `afterEach`) to
 * prove `formatMonthYear`'s result is genuinely independent of the runtime
 * timezone, rather than merely happening to pass because CI runs in UTC.
 * Node.js re-reads `process.env.TZ` on every `Intl`/`Date` call rather than
 * caching it at process start, so flipping it mid-test is a faithful
 * reproduction of "a server process running in a non-UTC timezone" without
 * needing a separate child process.
 */
describe("formatMonthYear", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("renders January for {year: 2026, month: 1} under a UTC-6 runtime, not December", () => {
    process.env.TZ = "America/Costa_Rica";
    expect(formatMonthYear(2026, 1, "en")).toBe("January 2026");
  });

  it("renders the correct Spanish month name under a UTC-6 runtime", () => {
    process.env.TZ = "America/Costa_Rica";
    expect(formatMonthYear(2026, 12, "es")).toContain("diciembre");
    expect(formatMonthYear(2026, 12, "es")).not.toContain("noviembre");
  });

  it("produces an identical result under a UTC runtime and a UTC-6 runtime", () => {
    process.env.TZ = "UTC";
    const underUtc = formatMonthYear(2026, 6, "en");

    process.env.TZ = "America/Costa_Rica";
    const underCostaRica = formatMonthYear(2026, 6, "en");

    expect(underCostaRica).toBe(underUtc);
    expect(underCostaRica).toBe("June 2026");
  });
});
