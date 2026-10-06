/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Owner financial-corrections UI brief §7 + correction round 2: component-level RTL tests — revision handling,
 * restricted-payment disablement, lost-response/recovery reconciliation (the `ReceiptRow`-precedent pattern, brief
 * §2.5), concurrent state changes (`alreadyRemoved`/`alreadyReversed` surfaced mid-flow), draft preservation through
 * an uncertain outcome, the exact FormData values each operation actually submits, the distinct WAIVED/VOIDED/
 * reversed/unchanged recovery copy (brief §1's corrected reasoning), AND round 2's own five fixes: multi-row refresh
 * survival (full-section tests — an isolated row with a mocked `onResolved` cannot prove this), explicit tender
 * entry + operation-specific confirmation copy, direct-vs-observed outcome copy, pagination, and stale-revision
 * reconciliation. Every case uses a `vi.fn()`-mocked action — none hits a real database (reader/auth correctness is
 * proven separately, against a real DB, in the integration test files).
 */

const correctLateFee = vi.fn();
const reversePaymentAction = vi.fn();
const waiveFee = vi.fn();
const getCorrectableLateFees = vi.fn();
const getReversiblePayments = vi.fn();
const getLateFeeStatus = vi.fn();
const getPaymentStatus = vi.fn();
vi.mock("../../src/lib/dues/financial-corrections-actions", () => ({
  correctLateFee, reversePaymentAction, waiveFee, getCorrectableLateFees, getReversiblePayments, getLateFeeStatus, getPaymentStatus,
}));

const { FinancialCorrectionsSection, LateFeeRow, PaymentRow } = await import("../../src/app/[locale]/(staff)/payments/financial-corrections-section");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function withMessages(children: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={enMessages}>{children}</NextIntlClientProvider>;
}

const FEE = {
  id: "fee-1", expectedRevision: "rev-1", obligationId: "ob-1", coverageYear: 2030, coverageMonth: 10,
  amount: "20.00", currency: "USD", obligationAmount: "100.00", graceDeadline: { year: 2030, month: 11, day: 5 },
};

const FEE2 = {
  id: "fee-2", expectedRevision: "rev-2a", obligationId: "ob-2", coverageYear: 2030, coverageMonth: 11,
  amount: "20.00", currency: "USD", obligationAmount: "100.00", graceDeadline: { year: 2030, month: 12, day: 5 },
};

const PAYMENT = {
  id: "pay-1", receivedOn: { year: 2030, month: 3, day: 20 }, tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO",
  restrictions: { hasUnsupportedObligationType: false, hasPrepaymentOrigin: false, hasVoidedFee: false },
};

const STUDENTS = [{ id: "s1", firstName: "Ana", lastName: "Soto", academyId: "a1", academyName: "Alliance" }];

beforeEach(() => {
  correctLateFee.mockReset();
  reversePaymentAction.mockReset();
  waiveFee.mockReset();
  getCorrectableLateFees.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  getReversiblePayments.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  getLateFeeStatus.mockReset();
  getPaymentStatus.mockReset();
});

describe("LateFeeRow: correction — explicit tender entry, obligation-amount reference context, operation-specific confirmation copy", () => {
  it("'Amount received' starts blank; the submitted value is exactly what the owner typed, never fee.amount", async () => {
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe("");
    // The obligation's own amount is shown as separate reference context, distinct from the fee amount.
    expect(screen.getByText(/Obligation amount/i)).toHaveTextContent("100.00");
    expect(screen.getByText(/voids this fee AND records a settlement/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner showed proof of on-time payment" } });
    fireEvent.change(screen.getByLabelText(/Date received/i), { target: { value: "2030-11-01" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(correctLateFee).toHaveBeenCalledTimes(1));
    const fd = correctLateFee.mock.calls[0][2] as FormData;
    expect(fd.get("tenderAmount")).toBe("97.50"); // the owner's own entry — never fee.amount ("20.00")
    expect(fd.get("expectedRevision")).toBe(FEE.expectedRevision);

    await waitFor(() => expect(screen.getByText(/voided and the obligation/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Correct and settle/i })).toBeNull();
  });
});

describe("LateFeeRow: waiver — explicit values and its own confirmation copy", () => {
  it("shows the waiver-specific confirmation copy and submits only lateFeeId/expectedRevision/removalReason", async () => {
    waiveFee.mockResolvedValue({ ok: true, feeId: FEE.id });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Waive/i }));
    expect(screen.getByText(/forgives only this unpaid fee/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner forgave it" } });
    fireEvent.click(screen.getByRole("button", { name: /Waive fee/i }));

    await waitFor(() => expect(waiveFee).toHaveBeenCalledTimes(1));
    const fd = waiveFee.mock.calls[0][2] as FormData;
    expect(fd.get("lateFeeId")).toBe(FEE.id);
    expect(fd.get("expectedRevision")).toBe(FEE.expectedRevision);
    expect(fd.get("receivedOn")).toBeNull();
    expect(fd.get("tenderCurrency")).toBeNull();

    await waitFor(() => expect(screen.getByText(/^This fee was waived\.$/)).toBeInTheDocument());
  });
});

describe("PaymentRow: reversal — its own confirmation copy and exact submitted values", () => {
  it("shows the reversal-specific confirmation copy; submits only paymentId/reversalReason", async () => {
    reversePaymentAction.mockResolvedValue({ ok: true, paymentId: PAYMENT.id, settlementIds: ["s1"] });
    render(withMessages(<PaymentRow organizationId="org-1" payment={PAYMENT} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Reverse/i }));
    expect(screen.getByText(/reverses the WHOLE selected payment/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner error" } });
    fireEvent.click(screen.getByRole("button", { name: /Reverse payment/i }));

    await waitFor(() => expect(reversePaymentAction).toHaveBeenCalledTimes(1));
    const fd = reversePaymentAction.mock.calls[0][2] as FormData;
    expect(fd.get("paymentId")).toBe(PAYMENT.id);
    expect(fd.get("reversalReason")).toBe("owner error");
    expect([...fd.keys()]).toHaveLength(2);

    await waitFor(() => expect(screen.getByText(/^This payment was reversed\.$/)).toBeInTheDocument());
  });
});

describe("LateFeeRow: direct success vs. recovery-observed outcome copy are genuinely distinct (correction round 2, issue 3)", () => {
  it("a recovery-observed VOIDED state renders DESCRIPTIVE copy, never the direct-success ('...was settled') copy", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    getLateFeeStatus.mockResolvedValueOnce({ id: FEE.id, removedAt: "2030-11-02T00:00:00.000Z", removalKind: "VOIDED", expectedRevision: "rev-9" });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/^This fee is now shown as voided\.$/)).toBeInTheDocument());
    // Never the direct-success claim, which the UI cannot actually back for a recovery-observed outcome.
    expect(screen.queryByText(/was settled using the entered amount/i)).toBeNull();
  });

  it("a DIRECT success renders the attributable copy, never the bare observed-only copy", async () => {
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/was settled using the entered amount and date/i)).toBeInTheDocument());
    expect(screen.queryByText(/^This fee is now shown as voided\.$/)).toBeNull();
  });
});

describe("LateFeeRow: a stale revision — genuinely reconciled, never a silent resubmit under the old one (correction round 2, issue 5)", () => {
  it("shows the stale error with its own reconcile control; reconciling fetches a fresh revision and the NEXT submit uses it", async () => {
    correctLateFee.mockResolvedValueOnce({ ok: false, error: "stale" });
    getLateFeeStatus.mockResolvedValueOnce({ id: FEE.id, removedAt: null, removalKind: null, expectedRevision: "rev-FRESH" });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "my draft survives" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/changed since it was loaded/i)).toBeInTheDocument());
    expect(correctLateFee).toHaveBeenCalledTimes(1); // no silent resubmit

    fireEvent.click(screen.getByRole("button", { name: /Refresh and try again/i }));
    await waitFor(() => expect(getLateFeeStatus).toHaveBeenCalledWith("org-1", FEE.id));
    await waitFor(() => expect(screen.queryByText(/changed since it was loaded/i)).toBeNull());

    // The draft survived the whole reconcile.
    expect((screen.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("my draft survives");

    correctLateFee.mockResolvedValueOnce({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));
    await waitFor(() => expect(correctLateFee).toHaveBeenCalledTimes(2));
    const fd = correctLateFee.mock.calls[1][2] as FormData;
    expect(fd.get("expectedRevision")).toBe("rev-FRESH"); // the reconciled one, never the stale original prop
  });
});

describe("LateFeeRow: settlement-total refusals render their own selectableTotals detail (correction round 2, issue 5)", () => {
  it("notASelectableTotal shows the distinct copy plus the valid totals, in the tender currency", async () => {
    correctLateFee.mockResolvedValue({ ok: false, error: "notASelectableTotal", selectableTotals: ["97.50 USD", "197.50 USD"] });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/doesn't match any valid total/i)).toBeInTheDocument());
    expect(screen.getByText(/97\.50 USD, 197\.50 USD/)).toBeInTheDocument();
  });
});

describe("LateFeeRow: older unpaid debt (notOldestFirst) — surfaced honestly, never implying the writer was widened", () => {
  it("shows the dedicated older-debt explanation alongside the generic refusal", async () => {
    correctLateFee.mockResolvedValue({ ok: false, error: "notOldestFirst" });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "100.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));
    await waitFor(() => expect(screen.getByText(/older unpaid debt that must be settled first/i)).toBeInTheDocument());
  });
});

describe("LateFeeRow: lost response (transport failure) — locked, exact-target recovery, draft preserved", () => {
  it("locks further writes, never auto-resubmits, recovers via the exact-target read, and distinguishes WAIVED from VOIDED", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    const statusRead = deferred<Awaited<ReturnType<typeof getLateFeeStatus>>>();
    getLateFeeStatus.mockReturnValueOnce(statusRead.promise);
    const onResolved = vi.fn();
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={onResolved} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "my typed reason survives" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Correct and settle/i })).toBeDisabled());
    expect((screen.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("my typed reason survives");
    expect(correctLateFee).toHaveBeenCalledTimes(1);

    statusRead.resolve({ id: FEE.id, removedAt: "2030-11-02T00:00:00.000Z", removalKind: "WAIVED", expectedRevision: "rev-2" });
    await waitFor(() => expect(screen.getByText(/^This fee is now shown as waived\.$/)).toBeInTheDocument());
    expect(onResolved).toHaveBeenCalled();
  });

  it("a recovery read that resolves to the genuinely unchanged state clears the lock, mentions the earlier request may still be running, and offers a real retry", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    getLateFeeStatus.mockResolvedValueOnce({ id: FEE.id, removedAt: null, removalKind: null, expectedRevision: FEE.expectedRevision });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/may still be in progress/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /Correct and settle/i })).not.toBeDisabled());
  });

  it("a recovery read that itself fails is distinct from a recovery read that succeeds — offers its own retry", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    getLateFeeStatus.mockRejectedValueOnce(new Error("still down"));
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/Couldn't check the current status/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Check status again/i })).toBeInTheDocument();
  });
});

describe("LateFeeRow: concurrent state change — a different action removed this fee mid-flow", () => {
  it("surfaces alreadyRemoved and resolves it via the exact-target recovery read, never silently retrying against a now-wrong target", async () => {
    correctLateFee.mockResolvedValueOnce({ ok: false, error: "alreadyRemoved" });
    getLateFeeStatus.mockResolvedValueOnce({ id: FEE.id, removedAt: "2030-11-01T00:00:00.000Z", removalKind: "VOIDED", expectedRevision: "rev-9" });
    const onResolved = vi.fn();
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={onResolved} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/^This fee is now shown as voided\.$/)).toBeInTheDocument());
    expect(onResolved).toHaveBeenCalled();
    expect(correctLateFee).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentRow: a restricted payment stays visible, disabled, with a specific explanation (brief §3 decision 4)", () => {
  it("a payment carrying a prepayment-origin obligation is never hidden, shows the named explanation, and its reverse action is disabled", () => {
    const restricted = { ...PAYMENT, restrictions: { hasUnsupportedObligationType: false, hasPrepaymentOrigin: true, hasVoidedFee: false } };
    render(withMessages(<PaymentRow organizationId="org-1" payment={restricted} onResolved={vi.fn()} />));
    expect(screen.getByText(/includes a prepaid future month/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reverse/i })).toBeDisabled();
  });

  it("an unrestricted payment's reverse action is enabled", () => {
    render(withMessages(<PaymentRow organizationId="org-1" payment={PAYMENT} onResolved={vi.fn()} />));
    expect(screen.getByRole("button", { name: /Reverse/i })).not.toBeDisabled();
  });
});

describe("FinancialCorrectionsSection: loads, paginates, and refreshes without destroying sibling row state (correction round 2, issue 1)", () => {
  it("loads fees and payments for the selected student", async () => {
    getCorrectableLateFees.mockResolvedValue({ rows: [FEE], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [PAYMENT], nextCursor: null });
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledWith("org-1", "s1"));
    expect(getReversiblePayments).toHaveBeenCalledWith("org-1", "s1");
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());
  });

  it("'Load older' fetches the next cursor page and appends it, without duplicating page 1's rows", async () => {
    getCorrectableLateFees
      .mockResolvedValueOnce({ rows: [FEE], nextCursor: "fee-1" })
      .mockResolvedValueOnce({ rows: [FEE2], nextCursor: null });
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());
    expect(screen.queryByText(/2030-11/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledWith("org-1", "s1", "fee-1"));
    await waitFor(() => expect(screen.getByText(/2030-11/)).toBeInTheDocument());
    // Page 1's own row is still there too — appended, not replaced.
    expect(screen.getByText(/2030-10/)).toBeInTheDocument();
    expect(screen.getAllByText(/2030-10|2030-11/)).toHaveLength(2);
  });

  it("a successful correction refreshes both lists in place; a SIBLING row's own typed draft and recovery-pending lock both survive the refresh, and the sibling's own write action is never called", async () => {
    // Page 1: both fees present. After FEE is corrected, the refreshed page shows only FEE2 (FEE left the
    // candidate set) — FEE2's own row component must be the SAME instance throughout (stable key), carrying its
    // own draft/lock state across the swap.
    getCorrectableLateFees
      .mockResolvedValueOnce({ rows: [FEE, FEE2], nextCursor: null })
      .mockResolvedValueOnce({ rows: [FEE2], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    // FEE2's own attempt fails with a transport error BEFORE FEE's own correction resolves — it must still be
    // locked, mid-recovery, after the sibling refresh.
    waiveFee.mockRejectedValueOnce(new Error("network down"));
    const statusRead = deferred<Awaited<ReturnType<typeof getLateFeeStatus>>>();
    getLateFeeStatus.mockReturnValueOnce(statusRead.promise);

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());
    expect(screen.getByText(/2030-11/)).toBeInTheDocument();

    const feeARow = within(screen.getByText(/2030-10/).closest("li")!);
    const feeBRow = within(screen.getByText(/2030-11/).closest("li")!);

    // FEE2 (row B): start a waiver, type a reason, submit — it fails with a transport error and locks, awaiting
    // its own exact-target recovery (the deferred promise above never resolves during this test).
    fireEvent.click(feeBRow.getByRole("button", { name: /Waive/i }));
    fireEvent.change(feeBRow.getByLabelText(/Reason/i), { target: { value: "row B's own draft" } });
    fireEvent.click(feeBRow.getByRole("button", { name: /Waive fee/i }));
    await waitFor(() => expect(feeBRow.getByRole("button", { name: /Waive fee/i })).toBeDisabled());

    // FEE (row A): correct it successfully — this triggers the parent's own in-place refresh.
    fireEvent.click(feeARow.getByRole("button", { name: /Correct/i }));
    fireEvent.change(feeARow.getByLabelText(/Reason/i), { target: { value: "row A reason" } });
    fireEvent.change(feeARow.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(feeARow.getByRole("button", { name: /Correct and settle/i }));
    await waitFor(() => expect(correctLateFee).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledTimes(2)); // the background refresh fired

    // Row B survived the refresh: its own draft is still visible, it is still locked/mid-recovery, and its own
    // write action was never called a second time as a side effect of row A's own resolution.
    const feeBRowAfter = within(screen.getByText(/2030-11/).closest("li")!);
    expect((feeBRowAfter.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("row B's own draft");
    expect(feeBRowAfter.getByRole("button", { name: /Waive fee/i })).toBeDisabled();
    expect(waiveFee).toHaveBeenCalledTimes(1); // never re-invoked by row A's own refresh

    // FEE A's own row is gone (it left the candidate list) — only FEE2's row remains.
    expect(screen.queryByText(/2030-10/)).toBeNull();
  });

  const FEE3 = {
    id: "fee-3", expectedRevision: "rev-3", obligationId: "ob-3", coverageYear: 2030, coverageMonth: 12,
    amount: "20.00", currency: "USD", obligationAmount: "100.00", graceDeadline: { year: 2031, month: 1, day: 5 },
  };

  it("correction round 3, issue 1: a page-2 draft survives a DIFFERENT row's successful operation and the refresh it triggers", async () => {
    // Page 1: FEE + FEE2. Load older: FEE3. Then FEE (unrelated to either draft) is corrected, triggering a
    // background refresh whose own fresh page-1 fetch returns only FEE2 (FEE left the candidate set).
    getCorrectableLateFees
      .mockResolvedValueOnce({ rows: [FEE, FEE2], nextCursor: "fee-2" })
      .mockResolvedValueOnce({ rows: [FEE3], nextCursor: null })
      .mockResolvedValueOnce({ rows: [FEE2], nextCursor: null }); // the refresh's own fresh page 1
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    await waitFor(() => expect(screen.getByText(/2030-12/)).toBeInTheDocument()); // FEE3, page 2

    // Type a draft into FEE3's own (page-2) waiver form — never submitted.
    const fee3Row = within(screen.getByText(/2030-12/).closest("li")!);
    fireEvent.click(fee3Row.getByRole("button", { name: /Waive/i }));
    fireEvent.change(fee3Row.getByLabelText(/Reason/i), { target: { value: "page-2 draft, never submitted" } });

    // FEE (page 1, unrelated) is corrected successfully — triggers refresh().
    const feeARow = within(screen.getByText(/2030-10/).closest("li")!);
    fireEvent.click(feeARow.getByRole("button", { name: /Correct/i }));
    fireEvent.change(feeARow.getByLabelText(/Reason/i), { target: { value: "row A reason" } });
    fireEvent.change(feeARow.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(feeARow.getByRole("button", { name: /Correct and settle/i }));
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledTimes(3)); // the background refresh fired

    // FEE3's own row (page 2) is still present, with its draft intact — never truncated back to page 1.
    const fee3RowAfter = within(screen.getByText(/2030-12/).closest("li")!);
    expect((fee3RowAfter.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("page-2 draft, never submitted");
    expect(waiveFee).not.toHaveBeenCalled();
  });

  it("correction round 3, issue 1: an uncertain row stays mounted and recoverable even when a sibling's refresh fetches a fresh candidate list that excludes it", async () => {
    // FEE2 goes uncertain (transport failure) first. Then FEE is corrected — the refresh's own fresh fetch returns
    // ONLY FEE (simulating that FEE2's own lost write actually succeeded server-side, so it's no longer a
    // candidate) — FEE2's own row must still be mounted, still showing its recovery UI, not vanished.
    getCorrectableLateFees
      .mockResolvedValueOnce({ rows: [FEE, FEE2], nextCursor: null })
      .mockResolvedValueOnce({ rows: [], nextCursor: null }); // refresh's fresh fetch excludes BOTH (FEE already explicitly removed; FEE2 excluded too)
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    waiveFee.mockRejectedValueOnce(new Error("network down"));
    const statusRead = deferred<Awaited<ReturnType<typeof getLateFeeStatus>>>();
    getLateFeeStatus.mockReturnValueOnce(statusRead.promise); // never resolves during this test — stays locked
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-11/)).toBeInTheDocument());

    const feeBRow = within(screen.getByText(/2030-11/).closest("li")!);
    fireEvent.click(feeBRow.getByRole("button", { name: /Waive/i }));
    fireEvent.change(feeBRow.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.click(feeBRow.getByRole("button", { name: /Waive fee/i }));
    await waitFor(() => expect(feeBRow.getByRole("button", { name: /Waive fee/i })).toBeDisabled());

    const feeARow = within(screen.getByText(/2030-10/).closest("li")!);
    fireEvent.click(feeARow.getByRole("button", { name: /Correct/i }));
    fireEvent.change(feeARow.getByLabelText(/Reason/i), { target: { value: "row A reason" } });
    fireEvent.change(feeARow.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(feeARow.getByRole("button", { name: /Correct and settle/i }));
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledTimes(2));

    // FEE2's own row is STILL mounted (not dropped by the sibling's refresh) and still shows its own recovery UI
    // (the recovery effect's own status-check fetch is already in flight — it never resolves during this test).
    expect(screen.getByText(/2030-11/)).toBeInTheDocument();
    expect(screen.getByText(/Checking the current status/i)).toBeInTheDocument();

    // Its own recovery now resolves to WAIVED — consistent with the established direct-success precedent (the
    // existing "FEE A's own row is gone" test above), a resolved row is explicitly removed from the list the
    // instant ITS OWN resolution confirms it, same mechanism either way (`onResolved(id, true)`). The point this
    // test actually proves: removal came from FEE2's OWN recovery, not from FEE A's earlier, unrelated refresh —
    // which had already run once and genuinely left FEE2 mounted and checking, not auto-dropped.
    getCorrectableLateFees.mockResolvedValueOnce({ rows: [], nextCursor: null }); // the removal's own follow-up refresh
    statusRead.resolve({ id: FEE2.id, removedAt: "2030-12-01T00:00:00.000Z", removalKind: "WAIVED", expectedRevision: "rev-9" });
    await waitFor(() => expect(screen.queryByText(/2030-11/)).toBeNull());
    expect(screen.getByText(/No correctable late fees/i)).toBeInTheDocument();
  });
});

describe("FinancialCorrectionsSection: 'Load older' is request-safe and recoverable (correction round 3, issue 2)", () => {
  it("fees: a deferred 'Load older' response for student A is discarded after switching to student B — A's rows never appear under B", async () => {
    getCorrectableLateFees.mockResolvedValueOnce({ rows: [FEE], nextCursor: "fee-1" });
    const loadMore = deferred<Awaited<ReturnType<typeof getCorrectableLateFees>>>();
    getCorrectableLateFees.mockReturnValueOnce(loadMore.promise); // student A's own "Load older"
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });

    const students = [...STUDENTS, { id: "s2", firstName: "Beto", lastName: "Mora", academyId: "a1", academyName: "Alliance" }];
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={students} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledTimes(2));

    // Switch to student B BEFORE student A's own "Load older" response lands.
    getCorrectableLateFees.mockResolvedValueOnce({ rows: [], nextCursor: null });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    await waitFor(() => expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s2"));
    expect(screen.queryByText(/2030-10/)).toBeNull();

    // A's own late-arriving page now resolves — must never apply to student B's own displayed list.
    loadMore.resolve({ rows: [FEE2], nextCursor: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/2030-11/)).toBeNull();
    expect(screen.queryByText(/2030-10/)).toBeNull();
  });

  it("payments: the identical discard applies to the payment list's own 'Load older'", async () => {
    getCorrectableLateFees.mockResolvedValue({ rows: [], nextCursor: null });
    getReversiblePayments.mockResolvedValueOnce({ rows: [PAYMENT], nextCursor: "pay-1" });
    const loadMore = deferred<Awaited<ReturnType<typeof getReversiblePayments>>>();
    getReversiblePayments.mockReturnValueOnce(loadMore.promise);

    const OTHER_PAYMENT = { ...PAYMENT, id: "pay-2", receivedOn: { year: 2029, month: 1, day: 1 } };
    const students = [...STUDENTS, { id: "s2", firstName: "Beto", lastName: "Mora", academyId: "a1", academyName: "Alliance" }];
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={students} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-03-20/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    await waitFor(() => expect(getReversiblePayments).toHaveBeenCalledTimes(2));

    getReversiblePayments.mockResolvedValueOnce({ rows: [], nextCursor: null });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    await waitFor(() => expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s2"));

    loadMore.resolve({ rows: [OTHER_PAYMENT], nextCursor: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/2029-01-01/)).toBeNull();
  });

  it("a rejected 'Load older' shows a dedicated error with its own retry; the already-loaded rows are untouched, and a successful retry appends correctly", async () => {
    getCorrectableLateFees
      .mockResolvedValueOnce({ rows: [FEE], nextCursor: "fee-1" })
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ rows: [FEE2], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    await waitFor(() => expect(screen.getByText(/Couldn't load more records/i)).toBeInTheDocument());
    expect(screen.getByText(/2030-10/)).toBeInTheDocument(); // untouched

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(screen.getByText(/2030-11/)).toBeInTheDocument());
    expect(screen.getByText(/2030-10/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load more records/i)).toBeNull();
  });
});

describe("FinancialCorrectionsSection: switching students is HARD-BLOCKED (never a dismissable confirm) while any row is writing or awaiting recovery (correction round 3, issue 3)", () => {
  const STUDENTS2 = [...STUDENTS, { id: "s2", firstName: "Beto", lastName: "Mora", academyId: "a1", academyName: "Alliance" }];

  it("the student selector is disabled while a row's own write is genuinely pending, and the attempted switch has no effect", async () => {
    getCorrectableLateFees.mockResolvedValue({ rows: [FEE], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    const write = deferred<Awaited<ReturnType<typeof correctLateFee>>>();
    correctLateFee.mockReturnValueOnce(write.promise);

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS2} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    // Still mid-flight (the deferred write promise has not resolved) — the selector is disabled right now.
    await waitFor(() => expect(screen.getByLabelText(/Student/i)).toBeDisabled());
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s1"); // unchanged
    expect(screen.getByText(/2030-10/)).toBeInTheDocument();

    write.resolve({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    await waitFor(() => expect(screen.getByLabelText(/Student/i)).not.toBeDisabled());
  });

  it("stays blocked after a rejected write (recovery-pending); only once recovery resolves to a confirmed/unchanged state does switching become available", async () => {
    getCorrectableLateFees.mockResolvedValue({ rows: [FEE], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    const statusRead = deferred<Awaited<ReturnType<typeof getLateFeeStatus>>>();
    getLateFeeStatus.mockReturnValueOnce(statusRead.promise);

    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS2} />));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "my draft" } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "97.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    // The write itself has already rejected (busy=false now), but the row is in recovery-pending — still blocked.
    await waitFor(() => expect(screen.getByRole("button", { name: /Correct and settle/i })).toBeDisabled());
    expect(screen.getByLabelText(/Student/i)).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s1"); // still blocked, no effect

    getCorrectableLateFees.mockResolvedValueOnce({ rows: [], nextCursor: null });
    statusRead.resolve({ id: FEE.id, removedAt: null, removalKind: null, expectedRevision: FEE.expectedRevision }); // unchanged
    await waitFor(() => expect(screen.getByLabelText(/Student/i)).not.toBeDisabled());

    // Now genuinely available.
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    await waitFor(() => expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s2"));

    // The draft survived the entire blocked window (never discarded, never auto-resubmitted).
    expect(correctLateFee).toHaveBeenCalledTimes(1);
  });

  it("switching students with nothing busy or uncertain is never blocked", async () => {
    getCorrectableLateFees.mockResolvedValue({ rows: [], nextCursor: null });
    getReversiblePayments.mockResolvedValue({ rows: [], nextCursor: null });
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={STUDENTS2} />));

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalled());
    expect(screen.getByLabelText(/Student/i)).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s2" } });
    await waitFor(() => expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("s2"));
  });
});
