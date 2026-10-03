import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner exchange-rate UI brief §5.2b: the ACTION's own composition logic (form parsing, field forwarding, result
 * mapping, success-only revalidation) — not the engine (exchange-rate-quote.test.ts covers that with a real
 * database) and not authorization against a real database (exchange-rate-actions-auth.test.ts covers that). Every
 * engine/query/auth dependency is `vi.mock()`'d at the MODULE level — an internal test seam at the import boundary,
 * never a parameter added to either action's public signature, matching the established
 * `tests/unit/create-student-form.test.tsx:14-16` pattern applied one layer lower (an action's own composition
 * instead of a component that calls one).
 */

const resolveActionContext = vi.fn();
const enterExchangeRateQuote = vi.fn();
const countPaymentsAgainstQuote = vi.fn();
const findCurrentExchangeRateQuote = vi.fn();
const revalidatePath = vi.fn();
const getLocale = vi.fn(async () => "en");

vi.mock("@/lib/tenant/context", () => ({ resolveActionContext }));
vi.mock("@/lib/dues/ledger/exchange-rate", () => ({ enterExchangeRateQuote }));
vi.mock("@/lib/dues/exchange-rate-queries", () => ({ countPaymentsAgainstQuote, findCurrentExchangeRateQuote }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({ getLocale }));

const { enterOrCorrectExchangeRate, getExchangeRateCorrectionWarning, getCurrentExchangeRate } = await import("../../src/lib/dues/exchange-rate-actions");

const ORG_ID = "org-1";
const OK_CONTEXT = { organizationId: ORG_ID, organizationRole: "ADMIN", actorUserId: "admin-1" };

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const VALID_FIELDS = { quoteYear: "2031", quoteMonth: "3", quoteDay: "15", value: "505.37", expectedCurrentRevision: "0" };

beforeEach(() => {
  resolveActionContext.mockReset();
  enterExchangeRateQuote.mockReset();
  countPaymentsAgainstQuote.mockReset();
  findCurrentExchangeRateQuote.mockReset();
  revalidatePath.mockReset();
  resolveActionContext.mockResolvedValue({ ok: true, context: OK_CONTEXT });
});

describe("enterOrCorrectExchangeRate: field forwarding", () => {
  it("forwards exactly the parsed date/value/revision/sourceNote, with context from resolveActionContext, never from the form", async () => {
    enterExchangeRateQuote.mockResolvedValue({ ok: true, quoteId: "q1", revision: 1 });
    await enterOrCorrectExchangeRate(ORG_ID, {}, formData({ ...VALID_FIELDS, sourceNote: "per BCR sheet" }));

    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(enterExchangeRateQuote).toHaveBeenCalledTimes(1);
    const [args, deps] = enterExchangeRateQuote.mock.calls[0];
    expect(args).toEqual({
      context: OK_CONTEXT,
      quoteDate: { year: 2031, month: 3, day: 15 },
      value: "505.37",
      expectedCurrentRevision: 0,
      sourceNote: "per BCR sheet",
    });
    // No deps argument — or an empty one. Never anything that could override production activation.
    expect(deps === undefined || Object.keys(deps as object).length === 0).toBe(true);
  });

  it("omits sourceNote (undefined, not an empty string) when the field is blank", async () => {
    enterExchangeRateQuote.mockResolvedValue({ ok: true, quoteId: "q1", revision: 1 });
    await enterOrCorrectExchangeRate(ORG_ID, {}, formData({ ...VALID_FIELDS, sourceNote: "   " }));
    expect(enterExchangeRateQuote.mock.calls[0][0].sourceNote).toBeUndefined();
  });

  it("a correction's expectedCurrentRevision (a positive integer from the hidden field) is forwarded exactly, not coerced to 0", async () => {
    enterExchangeRateQuote.mockResolvedValue({ ok: true, quoteId: "q2", revision: 4 });
    await enterOrCorrectExchangeRate(ORG_ID, {}, formData({ ...VALID_FIELDS, expectedCurrentRevision: "3" }));
    expect(enterExchangeRateQuote.mock.calls[0][0].expectedCurrentRevision).toBe(3);
  });
});

describe("enterOrCorrectExchangeRate: result mapping", () => {
  it("ok: true maps to { ok: true }, verbatim, with no extra fields", async () => {
    enterExchangeRateQuote.mockResolvedValue({ ok: true, quoteId: "q1", revision: 1 });
    const result = await enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS));
    expect(result).toEqual({ ok: true });
  });

  for (const error of ["notActive", "invalid", "notFound", "stale"] as const) {
    it(`ok: false, error: "${error}" maps to { error: "${error}" }, verbatim`, async () => {
      enterExchangeRateQuote.mockResolvedValue({ ok: false, error });
      const result = await enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS));
      expect(result).toEqual({ error });
    });
  }

  it("a non-member/inactive-org resolveActionContext result maps to notFound, without ever calling the engine", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    const result = await enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS));
    expect(result).toEqual({ error: "notFound" });
    expect(enterExchangeRateQuote).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw from resolveActionContext propagates uncaught, not a resolved ActionState", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
    expect(enterExchangeRateQuote).not.toHaveBeenCalled();
  });
});

describe("enterOrCorrectExchangeRate: revalidation fires only on success", () => {
  it("calls revalidatePath exactly once on ok: true", async () => {
    enterExchangeRateQuote.mockResolvedValue({ ok: true, quoteId: "q1", revision: 1 });
    await enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  for (const error of ["notActive", "invalid", "notFound", "stale"] as const) {
    it(`never calls revalidatePath on error: "${error}"`, async () => {
      enterExchangeRateQuote.mockResolvedValue({ ok: false, error });
      await enterOrCorrectExchangeRate(ORG_ID, {}, formData(VALID_FIELDS));
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("never calls revalidatePath on a local invalid (missing field), nor the engine", async () => {
    await enterOrCorrectExchangeRate(ORG_ID, {}, formData({ quoteYear: "2031" }));
    expect(enterExchangeRateQuote).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("enterOrCorrectExchangeRate: local invalid guard, before the engine is ever called", () => {
  const cases: Array<{ label: string; fields: Record<string, string> }> = [
    { label: "missing value", fields: { quoteYear: "2031", quoteMonth: "3", quoteDay: "15", expectedCurrentRevision: "0" } },
    { label: "blank value", fields: { ...VALID_FIELDS, value: "   " } },
    { label: "missing quoteDate field", fields: { quoteYear: "2031", quoteMonth: "3", value: "505.37", expectedCurrentRevision: "0" } },
    { label: "non-digit quoteYear", fields: { ...VALID_FIELDS, quoteYear: "abcd" } },
    { label: "missing expectedCurrentRevision", fields: { quoteYear: "2031", quoteMonth: "3", quoteDay: "15", value: "505.37" } },
    { label: "non-digit expectedCurrentRevision", fields: { ...VALID_FIELDS, expectedCurrentRevision: "abc" } },
  ];
  for (const { label, fields } of cases) {
    it(`${label}: returns invalid locally, never reaches the mocked engine`, async () => {
      const result = await enterOrCorrectExchangeRate(ORG_ID, {}, formData(fields));
      expect(result).toEqual({ error: "invalid" });
      expect(enterExchangeRateQuote).not.toHaveBeenCalled();
    });
  }
});

describe("getExchangeRateCorrectionWarning", () => {
  it("forwards to countPaymentsAgainstQuote with the exact organizationId and quoteId, after a real auth check", async () => {
    countPaymentsAgainstQuote.mockResolvedValue(7);
    const result = await getExchangeRateCorrectionWarning(ORG_ID, "quote-5");
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(countPaymentsAgainstQuote).toHaveBeenCalledWith(ORG_ID, "quote-5");
    expect(result).toBe(7);
  });

  it("a non-member/inactive-org result returns 0, without calling countPaymentsAgainstQuote", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    const result = await getExchangeRateCorrectionWarning(ORG_ID, "quote-5");
    expect(result).toBe(0);
    expect(countPaymentsAgainstQuote).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getExchangeRateCorrectionWarning(ORG_ID, "quote-5")).rejects.toThrow("FORBIDDEN");
  });
});

describe("getCurrentExchangeRate", () => {
  it("forwards to findCurrentExchangeRateQuote with the exact organizationId and quoteDate, after a real auth check", async () => {
    const row = { id: "q9", quoteDate: { year: 2031, month: 3, day: 15 }, revision: 2, value: "510.00" };
    findCurrentExchangeRateQuote.mockResolvedValue(row);
    const result = await getCurrentExchangeRate(ORG_ID, { year: 2031, month: 3, day: 15 });
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(findCurrentExchangeRateQuote).toHaveBeenCalledWith(ORG_ID, { year: 2031, month: 3, day: 15 });
    expect(result).toEqual(row);
  });

  it("a non-member/inactive-org result returns null, without calling findCurrentExchangeRateQuote", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    const result = await getCurrentExchangeRate(ORG_ID, { year: 2031, month: 3, day: 15 });
    expect(result).toBeNull();
    expect(findCurrentExchangeRateQuote).not.toHaveBeenCalled();
  });
});
