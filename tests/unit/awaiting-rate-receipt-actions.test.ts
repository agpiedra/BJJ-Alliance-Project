import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner awaiting-rate receipt queue brief §5.3 (action-composition tier): the ACTIONS' own composition logic (form
 * parsing, field forwarding, result mapping, the corrected revalidate-on-success-OR-already-terminal rule) — not the
 * engine (already fully tested in awaiting-rate-receipt.test.ts) and not authorization against a real database
 * (awaiting-rate-receipt-actions-auth.test.ts covers that). Every engine/query/auth dependency is `vi.mock()`'d at
 * the MODULE level, never a parameter added to any of the four actions' public signatures — the same internal test
 * seam `exchange-rate-actions.test.ts` already established, applied one feature over.
 */

const resolveActionContext = vi.fn();
const resolveAwaitingRateReceipt = vi.fn();
const cancelAwaitingRateReceipt = vi.fn();
const findReceiptStatus = vi.fn();
const listAwaitingRateReceipts = vi.fn();
const revalidatePath = vi.fn();
const getLocale = vi.fn(async () => "en");

vi.mock("@/lib/tenant/context", () => ({ resolveActionContext }));
vi.mock("@/lib/dues/ledger/awaiting-rate-receipt", () => ({ resolveAwaitingRateReceipt, cancelAwaitingRateReceipt }));
vi.mock("@/lib/dues/awaiting-rate-receipt-queries", () => ({ findReceiptStatus, listAwaitingRateReceipts }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({ getLocale }));

const { resolveReceipt, cancelReceipt, getReceiptStatus, listReceipts } = await import("../../src/lib/dues/awaiting-rate-receipt-actions");

const ORG_ID = "org-1";
const OK_CONTEXT = { organizationId: ORG_ID, organizationRole: "ADMIN", actorUserId: "admin-1" };

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const REACHABLE_RESOLVE_ERRORS = [
  "invalid", "notFound", "alreadyResolved", "alreadyCancelled", "malformedSnapshot", "staleTerms", "staleSelection",
  "noLongerFuture", "alreadySettled", "notOldestFirst", "feeAlreadyAssessed", "amountUnsupported", "rateUnavailable",
  "currencyMismatch", "ambiguousTotal", "notASelectableTotal", "totalMismatch", "conflict",
] as const;
const UNREACHABLE_RESOLVE_ERRORS = ["futureDate", "tooOld", "captured"] as const;

beforeEach(() => {
  resolveActionContext.mockReset();
  resolveAwaitingRateReceipt.mockReset();
  cancelAwaitingRateReceipt.mockReset();
  findReceiptStatus.mockReset();
  listAwaitingRateReceipts.mockReset();
  revalidatePath.mockReset();
  resolveActionContext.mockResolvedValue({ ok: true, context: OK_CONTEXT });
});

describe("resolveReceipt: field forwarding and the local blank-receiptId guard", () => {
  it("forwards exactly the parsed receiptId, with context from resolveActionContext, never a deps argument", async () => {
    resolveAwaitingRateReceipt.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], totalMinor: 10000 });
    await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }));
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(resolveAwaitingRateReceipt).toHaveBeenCalledTimes(1);
    const call = resolveAwaitingRateReceipt.mock.calls[0];
    expect(call[0]).toEqual({ context: OK_CONTEXT, receiptId: "r1" });
    expect(call.length).toBe(1); // no second (deps) argument, ever
  });

  it("a blank or missing receiptId returns invalid locally, never calling the engine", async () => {
    expect(await resolveReceipt(ORG_ID, {}, formData({ receiptId: "   " }))).toEqual({ error: "invalid" });
    expect(await resolveReceipt(ORG_ID, {}, formData({}))).toEqual({ error: "invalid" });
    expect(resolveAwaitingRateReceipt).not.toHaveBeenCalled();
  });

  it("a non-member/inactive-org resolveActionContext result maps to notFound, without ever calling the engine", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    expect(await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }))).toEqual({ error: "notFound" });
    expect(resolveAwaitingRateReceipt).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw from resolveActionContext propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }))).rejects.toThrow("FORBIDDEN");
    expect(resolveAwaitingRateReceipt).not.toHaveBeenCalled();
  });
});

describe("resolveReceipt: result mapping — every reachable AND unreachable error maps to its own distinct ActionState", () => {
  it("ok: true maps to { ok: true }, verbatim", async () => {
    resolveAwaitingRateReceipt.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], totalMinor: 10000 });
    expect(await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }))).toEqual({ ok: true });
  });

  for (const error of [...REACHABLE_RESOLVE_ERRORS, ...UNREACHABLE_RESOLVE_ERRORS]) {
    it(`error: "${error}" maps to { error: "${error}" }, verbatim — none collapsed into a shared fallback`, async () => {
      resolveAwaitingRateReceipt.mockResolvedValue({ ok: false, error });
      expect(await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }))).toEqual({ error });
    });
  }
});

describe("resolveReceipt: corrected revalidation rule — fires on ok:true AND alreadyResolved/alreadyCancelled, never on any other error", () => {
  it("calls revalidatePath on ok: true", async () => {
    resolveAwaitingRateReceipt.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], totalMinor: 10000 });
    await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }));
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("calls revalidatePath on alreadyResolved and on alreadyCancelled — the stored truth changed even though this call didn't cause a successful write", async () => {
    resolveAwaitingRateReceipt.mockResolvedValue({ ok: false, error: "alreadyResolved" });
    await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }));
    expect(revalidatePath).toHaveBeenCalledTimes(1);

    revalidatePath.mockClear();
    resolveAwaitingRateReceipt.mockResolvedValue({ ok: false, error: "alreadyCancelled" });
    await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r2" }));
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  for (const error of [...REACHABLE_RESOLVE_ERRORS.filter((e) => e !== "alreadyResolved" && e !== "alreadyCancelled"), ...UNREACHABLE_RESOLVE_ERRORS]) {
    it(`never calls revalidatePath on error: "${error}"`, async () => {
      resolveAwaitingRateReceipt.mockResolvedValue({ ok: false, error });
      await resolveReceipt(ORG_ID, {}, formData({ receiptId: "r1" }));
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("never calls revalidatePath on a local invalid (missing receiptId), nor the engine", async () => {
    await resolveReceipt(ORG_ID, {}, formData({}));
    expect(resolveAwaitingRateReceipt).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("cancelReceipt: field forwarding, the local blank-reason/blank-receiptId guards, result mapping, revalidation", () => {
  it("forwards exactly the parsed receiptId/reason, with context from resolveActionContext, never a deps argument", async () => {
    cancelAwaitingRateReceipt.mockResolvedValue({ ok: true, receiptId: "r1" });
    await cancelReceipt(ORG_ID, {}, formData({ receiptId: "r1", reason: "owner changed their mind" }));
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    const call = cancelAwaitingRateReceipt.mock.calls[0];
    expect(call[0]).toEqual({ context: OK_CONTEXT, receiptId: "r1", reason: "owner changed their mind" });
    expect(call.length).toBe(1);
  });

  it("a blank reason returns invalid locally, never calling the engine", async () => {
    expect(await cancelReceipt(ORG_ID, {}, formData({ receiptId: "r1", reason: "   " }))).toEqual({ error: "invalid" });
    expect(await cancelReceipt(ORG_ID, {}, formData({ receiptId: "r1" }))).toEqual({ error: "invalid" });
    expect(cancelAwaitingRateReceipt).not.toHaveBeenCalled();
  });

  it("a blank receiptId returns invalid locally, never calling the engine, even with a valid reason", async () => {
    expect(await cancelReceipt(ORG_ID, {}, formData({ receiptId: "", reason: "valid reason" }))).toEqual({ error: "invalid" });
    expect(cancelAwaitingRateReceipt).not.toHaveBeenCalled();
  });

  it("ok: true maps to { ok: true } and revalidates", async () => {
    cancelAwaitingRateReceipt.mockResolvedValue({ ok: true, receiptId: "r1" });
    expect(await cancelReceipt(ORG_ID, {}, formData({ receiptId: "r1", reason: "x" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  for (const error of ["notActive", "invalid", "notFound", "alreadyResolved", "alreadyCancelled"] as const) {
    it(`error: "${error}" maps verbatim, and revalidates only for the already-terminal cases`, async () => {
      cancelAwaitingRateReceipt.mockResolvedValue({ ok: false, error });
      expect(await cancelReceipt(ORG_ID, {}, formData({ receiptId: "r1", reason: "x" }))).toEqual({ error });
      const shouldRevalidate = error === "alreadyResolved" || error === "alreadyCancelled";
      expect(revalidatePath.mock.calls.length > 0).toBe(shouldRevalidate);
    });
  }
});

describe("getReceiptStatus: field forwarding, auth outcomes, not activation-gated", () => {
  it("forwards to findReceiptStatus after a real auth check", async () => {
    findReceiptStatus.mockResolvedValue({ status: "PENDING" });
    expect(await getReceiptStatus(ORG_ID, "r1")).toEqual({ status: "PENDING" });
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(findReceiptStatus).toHaveBeenCalledWith(ORG_ID, "r1");
  });

  it("a non-member/inactive-org result returns null, without calling findReceiptStatus", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    expect(await getReceiptStatus(ORG_ID, "r1")).toBeNull();
    expect(findReceiptStatus).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getReceiptStatus(ORG_ID, "r1")).rejects.toThrow("FORBIDDEN");
  });
});

describe("listReceipts: field forwarding, auth outcomes, not activation-gated", () => {
  it("forwards to listAwaitingRateReceipts after a real auth check", async () => {
    listAwaitingRateReceipts.mockResolvedValue({ rows: [], nextCursor: null });
    await listReceipts(ORG_ID, { status: "PENDING", cursor: "c1" });
    expect(resolveActionContext).toHaveBeenCalledWith(ORG_ID, ["ADMIN"]);
    expect(listAwaitingRateReceipts).toHaveBeenCalledWith(ORG_ID, { status: "PENDING", cursor: "c1" });
  });

  it("a non-member/inactive-org result returns an empty page, without calling the reader", async () => {
    resolveActionContext.mockResolvedValue({ ok: false });
    expect(await listReceipts(ORG_ID, {})).toEqual({ rows: [], nextCursor: null });
    expect(listAwaitingRateReceipts).not.toHaveBeenCalled();
  });

  it("a genuine-member-wrong-role throw propagates uncaught", async () => {
    resolveActionContext.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(listReceipts(ORG_ID, {})).rejects.toThrow("FORBIDDEN");
  });
});
