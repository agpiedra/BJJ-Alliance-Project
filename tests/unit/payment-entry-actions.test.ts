import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * Ordinary payment-entry UI brief §8 tier 3: the ACTIONS' own composition logic (field parsing/forwarding, D4's
 * literal maxBackdateDays, result mapping for all six result shapes, the revalidate-only-on-genuinely-new-write
 * rule) — not the engine (already fully tested, PR #89) and not authorization against a real database
 * (payment-entry-actions-auth.test.ts covers that). Every dependency is `vi.mock()`'d, the same internal test seam
 * `awaiting-rate-receipt-actions.test.ts`/`exchange-rate-actions.test.ts` already establish.
 */

const resolveActionContext = vi.fn();
const recordDuesPaymentWithSubmissionIdentity = vi.fn();
const getSubmissionOutcome = vi.fn();
const listPayableObligations = vi.fn();
const orderPayableOldestFirst = vi.fn();
const isMixedCurrency = vi.fn();
const getStudentBranchLocalToday = vi.fn();
const revalidatePath = vi.fn();
const getLocale = vi.fn(async () => "en");

vi.mock("@/lib/tenant/context", () => ({ resolveActionContext }));
vi.mock("@/lib/dues/ledger/submission-identity", () => ({ recordDuesPaymentWithSubmissionIdentity, getSubmissionOutcome }));
// NOT `vi.importActual` here: the real module imports `dues-facts.ts` -> `prisma`, which requires `DATABASE_URL` at
// module load time — this test never touches a database. `orderPayableOldestFirst`/`isMixedCurrency`/
// `getStudentBranchLocalToday`'s own real behavior is exercised directly in `payment-entry-queries.test.ts` (tier 1,
// real DB); this tier only proves `getPayableObligations` wires their results through correctly.
vi.mock("@/lib/dues/payment-entry-queries", () => ({ listPayableObligations, orderPayableOldestFirst, isMixedCurrency, getStudentBranchLocalToday }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({ getLocale }));

const { recordPayment, checkSubmissionOutcome, getPayableObligations } = await import("../../src/lib/dues/payment-entry-actions");

const ORG_ID = "org-1";
const OK_CONTEXT = { kind: "tenant", organizationId: ORG_ID, organizationRole: "ADMIN", actorUserId: "admin-1", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };

function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, v);
    else fd.set(key, value);
  }
  return fd;
}

const VALID_FIELDS = {
  studentId: "student-1",
  obligationIds: ["ob-1", "ob-2"],
  receivedOn: "2027-03-10",
  tenderCurrency: "USD",
  tenderAmount: "100.00",
  method: "EFECTIVO",
  submissionId: "sub-1",
};

beforeEach(() => {
  resolveActionContext.mockReset();
  recordDuesPaymentWithSubmissionIdentity.mockReset();
  getSubmissionOutcome.mockReset();
  listPayableObligations.mockReset();
  orderPayableOldestFirst.mockReset();
  isMixedCurrency.mockReset();
  getStudentBranchLocalToday.mockReset();
  revalidatePath.mockReset();
  resolveActionContext.mockResolvedValue({ ok: true, context: OK_CONTEXT });
  getStudentBranchLocalToday.mockResolvedValue({ year: 2027, month: 3, day: 10 });
});

describe("recordPayment: authorization", () => {
  it("authorizes ADMIN/DIRECTOR only, never a broader role list", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: [], feeIds: [], totalMinor: 10000 });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN", "DIRECTOR"]);
  });

  it("a non-member/inactive-org result maps to notFound, never calling the engine", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    expect(await recordPayment(ORG_ID, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notFound" });
    expect(recordDuesPaymentWithSubmissionIdentity).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw from resolveActionContext propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(recordPayment(ORG_ID, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
    expect(recordDuesPaymentWithSubmissionIdentity).not.toHaveBeenCalled();
  });
});

describe("recordPayment: field forwarding and D4's literal maxBackdateDays", () => {
  it("forwards exactly the parsed fields, context from resolveActionContext, maxBackdateDays=30 literal", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: [], feeIds: [], totalMinor: 10000 });
    await recordPayment(ORG_ID, {}, formData({ ...VALID_FIELDS, notes: "a note" }));
    expect(recordDuesPaymentWithSubmissionIdentity).toHaveBeenCalledTimes(1);
    const call = recordDuesPaymentWithSubmissionIdentity.mock.calls[0][0];
    expect(call).toEqual({
      context: OK_CONTEXT,
      studentId: "student-1",
      receivedOn: { year: 2027, month: 3, day: 10 },
      tender: { currency: "USD", amount: "100.00" },
      method: "EFECTIVO",
      obligationIds: ["ob-1", "ob-2"],
      notes: "a note",
      maxBackdateDays: 30,
      submissionId: "sub-1",
    });
  });

  it("maxBackdateDays is NEVER read from formData, even if a malicious client includes one", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: [], feeIds: [], totalMinor: 10000 });
    const fd = formData(VALID_FIELDS);
    fd.set("maxBackdateDays", "99999");
    await recordPayment(ORG_ID, {}, fd);
    expect(recordDuesPaymentWithSubmissionIdentity.mock.calls[0][0].maxBackdateDays).toBe(30);
  });

  it("notes is undefined when blank/absent, never an empty string", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: [], feeIds: [], totalMinor: 10000 });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(recordDuesPaymentWithSubmissionIdentity.mock.calls[0][0].notes).toBeUndefined();
  });
});

describe("recordPayment: local input-guard short-circuits (never calling the engine)", () => {
  const cases: Array<[string, Partial<typeof VALID_FIELDS> | Record<string, unknown>]> = [
    ["missing studentId", { ...VALID_FIELDS, studentId: "" }],
    ["no obligationIds at all", { ...VALID_FIELDS, obligationIds: [] }],
    ["unparseable receivedOn", { ...VALID_FIELDS, receivedOn: "not-a-date" }],
    ["invalid tenderCurrency", { ...VALID_FIELDS, tenderCurrency: "EUR" }],
    ["blank tenderAmount", { ...VALID_FIELDS, tenderAmount: "" }],
    ["invalid method", { ...VALID_FIELDS, method: "BITCOIN" }],
    ["blank submissionId", { ...VALID_FIELDS, submissionId: "" }],
  ];
  for (const [label, fields] of cases) {
    it(`${label} returns invalid locally`, async () => {
      expect(await recordPayment(ORG_ID, {}, formData(fields as Record<string, string | string[]>))).toEqual({ ok: false, error: "invalid" });
      expect(recordDuesPaymentWithSubmissionIdentity).not.toHaveBeenCalled();
    });
  }
});

describe("recordPayment: result mapping — all six result shapes passed through verbatim", () => {
  const shapes: Array<[string, unknown]> = [
    ["fresh settlement", { ok: true, paymentId: "p1", settlementIds: ["s1"], feeIds: [], totalMinor: 10000 }],
    ["replay, not reversed", { ok: true, paymentId: "p1", replay: true, currentlyReversed: false }],
    ["replay, reversed", { ok: true, paymentId: "p1", replay: true, currentlyReversed: true }],
    ["fresh capture", { ok: false, error: "captured", receiptId: "r1" }],
    ["replay capture", { ok: false, error: "captured", receiptId: "r1", replay: true, currentStatus: "RESOLVED" }],
    ["payload mismatch", { ok: false, error: "submissionPayloadMismatch" }],
    ["ordinary refusal", { ok: false, error: "notOldestFirst" }],
    ["ordinary refusal with selectableTotals", { ok: false, error: "totalMismatch", selectableTotals: ["100.00"] }],
  ];
  for (const [label, shape] of shapes) {
    it(`${label} is returned verbatim`, async () => {
      recordDuesPaymentWithSubmissionIdentity.mockResolvedValue(shape);
      expect(await recordPayment(ORG_ID, {}, formData(VALID_FIELDS))).toEqual(shape);
    });
  }
});

describe("recordPayment: revalidation fires only when something genuinely new was written", () => {
  it("revalidates on fresh settlement (ok:true, no replay)", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: [], feeIds: [], totalMinor: 10000 });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("revalidates on fresh capture (captured, no replay)", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: false, error: "captured", receiptId: "r1" });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("does NOT revalidate on a replay of a committed payment (nothing new happened)", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: true, paymentId: "p1", replay: true, currentlyReversed: false });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT revalidate on a replay capture", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: false, error: "captured", receiptId: "r1", replay: true, currentStatus: "PENDING" });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT revalidate on an ordinary refusal", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: false, error: "notActive" });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT revalidate on submissionPayloadMismatch", async () => {
    recordDuesPaymentWithSubmissionIdentity.mockResolvedValue({ ok: false, error: "submissionPayloadMismatch" });
    await recordPayment(ORG_ID, {}, formData(VALID_FIELDS));
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT revalidate on a local invalid guard (engine never called)", async () => {
    await recordPayment(ORG_ID, {}, formData({ ...VALID_FIELDS, studentId: "" }));
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("checkSubmissionOutcome: a pure passthrough wrapper", () => {
  it("forwards to getSubmissionOutcome and returns its result verbatim", async () => {
    getSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } });
    expect(await checkSubmissionOutcome(ORG_ID, "sub-1")).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } });
    expect(getSubmissionOutcome).toHaveBeenCalledWith(ORG_ID, "sub-1");
  });

  it("a thrown FORBIDDEN propagates uncaught — never swallowed into a resolved status", async () => {
    getSubmissionOutcome.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(checkSubmissionOutcome(ORG_ID, "sub-1")).rejects.toThrow("FORBIDDEN");
  });

  it("a resolved notFound passes through verbatim", async () => {
    getSubmissionOutcome.mockResolvedValue({ status: "notFound" });
    expect(await checkSubmissionOutcome(ORG_ID, "sub-1")).toEqual({ status: "notFound" });
  });
});

describe("getPayableObligations: authorization and oldest-first/mixed-currency computation", () => {
  it("a non-member/inactive-org result maps to notFound, never calling the reader", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    expect(await getPayableObligations(ORG_ID, "student-1")).toEqual({ ok: false, error: "notFound" });
    expect(listPayableObligations).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getPayableObligations(ORG_ID, "student-1")).rejects.toThrow("FORBIDDEN");
  });

  it("passes through a reader refusal verbatim", async () => {
    listPayableObligations.mockResolvedValue({ ok: false, error: "notActive" });
    expect(await getPayableObligations(ORG_ID, "student-1")).toEqual({ ok: false, error: "notActive" });
  });

  it("wires the reader's obligations through orderPayableOldestFirst/isMixedCurrency and returns their results, plus the branch-local today", async () => {
    const newer = { obligationId: "newer", type: "MONTHLY", currency: "USD", coverageYear: 2027, coverageMonth: 3, settled: false, outstandingAmountMinor: 10000, outstandingFeeMinor: 0, dueOn: "2027-03-20", pastGrace: false };
    const older = { ...newer, obligationId: "older", coverageYear: 2027, coverageMonth: 2 };
    listPayableObligations.mockResolvedValue({ ok: true, obligations: [newer, older] });
    orderPayableOldestFirst.mockReturnValue([older, newer]);
    isMixedCurrency.mockReturnValue(false);
    getStudentBranchLocalToday.mockResolvedValue({ year: 2027, month: 3, day: 15 });

    const result = await getPayableObligations(ORG_ID, "student-1");

    expect(orderPayableOldestFirst).toHaveBeenCalledWith([newer, older]);
    expect(isMixedCurrency).toHaveBeenCalledWith([newer, older]);
    expect(getStudentBranchLocalToday).toHaveBeenCalledWith(OK_CONTEXT, "student-1");
    expect(result).toEqual({ ok: true, obligations: [older, newer], mixedCurrency: false, todayLocal: { year: 2027, month: 3, day: 15 } });
  });

  it("returns mixedCurrency: true when isMixedCurrency reports it", async () => {
    listPayableObligations.mockResolvedValue({ ok: true, obligations: [] });
    orderPayableOldestFirst.mockReturnValue([]);
    isMixedCurrency.mockReturnValue(true);
    const result = await getPayableObligations(ORG_ID, "student-1");
    expect(result.ok && result.mixedCurrency).toBe(true);
  });

  it("resolves notFound if the branch-local-today lookup itself can't resolve the student (point 7)", async () => {
    listPayableObligations.mockResolvedValue({ ok: true, obligations: [] });
    orderPayableOldestFirst.mockReturnValue([]);
    isMixedCurrency.mockReturnValue(false);
    getStudentBranchLocalToday.mockResolvedValue(null);
    expect(await getPayableObligations(ORG_ID, "student-1")).toEqual({ ok: false, error: "notFound" });
  });
});
