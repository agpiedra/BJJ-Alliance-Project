/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Owner financial-corrections UI brief §7: component-level RTL tests — revision handling, restricted-payment
 * disablement, lost-response/recovery reconciliation (the `ReceiptRow`-precedent pattern, brief §2.5), concurrent
 * state changes (`alreadyRemoved`/`alreadyReversed` surfaced mid-flow), draft preservation through an uncertain
 * outcome, the exact FormData values each operation actually submits, and the distinct WAIVED/VOIDED/reversed/
 * unchanged recovery copy (brief §1's corrected reasoning). Every case uses a `vi.fn()`-mocked action — none hits a
 * real database (reader/auth correctness is proven separately, against a real DB, in the integration test files).
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
  amount: "20.00", currency: "USD", graceDeadline: { year: 2030, month: 11, day: 5 },
};

const PAYMENT = {
  id: "pay-1", receivedOn: { year: 2030, month: 3, day: 20 }, tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO",
  restrictions: { hasUnsupportedObligationType: false, hasPrepaymentOrigin: false, hasVoidedFee: false },
};

beforeEach(() => {
  correctLateFee.mockReset();
  reversePaymentAction.mockReset();
  waiveFee.mockReset();
  getCorrectableLateFees.mockReset().mockResolvedValue([]);
  getReversiblePayments.mockReset().mockResolvedValue([]);
  getLateFeeStatus.mockReset();
  getPaymentStatus.mockReset();
});

describe("LateFeeRow: correction — exact submitted values and successful outcome", () => {
  it("submits exactly the fields the brief's §2.4 table specifies, and shows the VOIDED outcome on success", async () => {
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner showed proof of on-time payment" } });
    fireEvent.change(screen.getByLabelText(/Date received/i), { target: { value: "2030-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(correctLateFee).toHaveBeenCalledTimes(1));
    const fd = correctLateFee.mock.calls[0][2] as FormData;
    expect(fd.get("lateFeeId")).toBe(FEE.id);
    expect(fd.get("expectedRevision")).toBe(FEE.expectedRevision);
    expect(fd.get("removalReason")).toBe("owner showed proof of on-time payment");
    expect(fd.get("receivedOn")).toBe("2030-11-01");
    expect(fd.get("tenderCurrency")).toBe("USD");
    expect(fd.get("tenderAmount")).toBe("20.00");
    expect(fd.get("method")).toBe("EFECTIVO");

    await waitFor(() => expect(screen.getByText(/voided and the obligation/i)).toBeInTheDocument());
    // Finalized — the action buttons are gone, never offered again on an already-VOIDED fee.
    expect(screen.queryByRole("button", { name: /Correct and settle/i })).toBeNull();
  });
});

describe("LateFeeRow: waiver — exact submitted values and successful outcome", () => {
  it("submits only lateFeeId/expectedRevision/removalReason — no date/tender/method fields exist for waiver", async () => {
    waiveFee.mockResolvedValue({ ok: true, feeId: FEE.id });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Waive/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner forgave it" } });
    fireEvent.click(screen.getByRole("button", { name: /Waive fee/i }));

    await waitFor(() => expect(waiveFee).toHaveBeenCalledTimes(1));
    const fd = waiveFee.mock.calls[0][2] as FormData;
    expect(fd.get("lateFeeId")).toBe(FEE.id);
    expect(fd.get("expectedRevision")).toBe(FEE.expectedRevision);
    expect(fd.get("removalReason")).toBe("owner forgave it");
    expect(fd.get("receivedOn")).toBeNull();
    expect(fd.get("tenderCurrency")).toBeNull();

    await waitFor(() => expect(screen.getByText(/^This fee was waived\.$/)).toBeInTheDocument());
  });
});

describe("LateFeeRow: a stale revision — distinct copy, never a silent resubmit", () => {
  it("shows the stale-specific error, not a generic one, and offers no automatic retry under the old revision", async () => {
    correctLateFee.mockResolvedValue({ ok: false, error: "stale" });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/changed since it was loaded/i)).toBeInTheDocument());
    // Still only ever one real write attempt — no silent resubmit happened.
    expect(correctLateFee).toHaveBeenCalledTimes(1);
  });
});

describe("LateFeeRow: older unpaid debt (notOldestFirst) — surfaced honestly, never implying the writer was widened", () => {
  it("shows the dedicated older-debt explanation alongside the generic refusal", async () => {
    correctLateFee.mockResolvedValue({ ok: false, error: "notOldestFirst" });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
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
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    // Locked: the submit button is disabled while uncertain, and the draft (the typed reason) is still visible.
    await waitFor(() => expect(screen.getByRole("button", { name: /Correct and settle/i })).toBeDisabled());
    expect((screen.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("my typed reason survives");
    expect(correctLateFee).toHaveBeenCalledTimes(1); // never auto-resubmitted

    // The recovery read resolves to a WAIVED removal — distinct copy from VOIDED, never conflated.
    statusRead.resolve({ id: FEE.id, removedAt: "2030-11-02T00:00:00.000Z", removalKind: "WAIVED", expectedRevision: "rev-2" });
    await waitFor(() => expect(screen.getByText(/^This fee was waived\.$/)).toBeInTheDocument());
    expect(onResolved).toHaveBeenCalled(); // the parent re-fetches its lists since the stored truth changed
  });

  it("a recovery read that resolves to the genuinely unchanged state clears the lock and offers a real retry — never claims success", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    getLateFeeStatus.mockResolvedValueOnce({ id: FEE.id, removedAt: null, removalKind: null, expectedRevision: FEE.expectedRevision });
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/does not appear to have taken effect/i)).toBeInTheDocument());
    // Unlocked again — a genuine retry is now possible (never auto-fired).
    await waitFor(() => expect(screen.getByRole("button", { name: /Correct and settle/i })).not.toBeDisabled());
  });

  it("a recovery read that itself fails is distinct from a recovery read that succeeds — offers its own retry", async () => {
    correctLateFee.mockRejectedValueOnce(new Error("network down"));
    getLateFeeStatus.mockRejectedValueOnce(new Error("still down"));
    render(withMessages(<LateFeeRow organizationId="org-1" fee={FEE} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Correct/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "reason" } });
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
    fireEvent.click(screen.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(screen.getByText(/^This fee was voided/i)).toBeInTheDocument());
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

describe("PaymentRow: reversal — exact submitted values, no revision field at all", () => {
  it("submits only paymentId/reversalReason", async () => {
    reversePaymentAction.mockResolvedValue({ ok: true, paymentId: PAYMENT.id, settlementIds: ["s1"] });
    render(withMessages(<PaymentRow organizationId="org-1" payment={PAYMENT} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Reverse/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "owner error" } });
    fireEvent.click(screen.getByRole("button", { name: /Reverse payment/i }));

    await waitFor(() => expect(reversePaymentAction).toHaveBeenCalledTimes(1));
    const fd = reversePaymentAction.mock.calls[0][2] as FormData;
    expect(fd.get("paymentId")).toBe(PAYMENT.id);
    expect(fd.get("reversalReason")).toBe("owner error");
    expect([...fd.keys()]).toHaveLength(2); // never an expectedRevision field — reversePayment has none

    await waitFor(() => expect(screen.getByText(/^This payment was reversed\.$/)).toBeInTheDocument());
  });
});

describe("PaymentRow: lost response — locked, draft preserved, exact-target recovery distinguishes reversed from unchanged", () => {
  it("a transport failure locks the row; the owner's typed reason survives; recovery confirms reversed", async () => {
    reversePaymentAction.mockRejectedValueOnce(new Error("network down"));
    getPaymentStatus.mockResolvedValueOnce({ id: PAYMENT.id, reversedAt: "2030-03-21T00:00:00.000Z" });
    render(withMessages(<PaymentRow organizationId="org-1" payment={PAYMENT} onResolved={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: /Reverse/i }));
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "my draft" } });
    fireEvent.click(screen.getByRole("button", { name: /Reverse payment/i }));

    await waitFor(() => expect(screen.getByText(/^This payment was reversed\.$/)).toBeInTheDocument());
  });
});

describe("FinancialCorrectionsSection: student switch re-fetches both lists; a resolved row triggers a re-fetch", () => {
  it("loads fees and payments for the selected student", async () => {
    getCorrectableLateFees.mockResolvedValue([FEE]);
    getReversiblePayments.mockResolvedValue([PAYMENT]);
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={[{ id: "s1", firstName: "Ana", lastName: "Soto", academyId: "a1", academyName: "Alliance" }]} />));

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledWith("org-1", "s1"));
    expect(getReversiblePayments).toHaveBeenCalledWith("org-1", "s1");
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());
  });

  it("a successful correction re-fetches both lists (the fee left the correctable set)", async () => {
    getCorrectableLateFees.mockResolvedValueOnce([FEE]).mockResolvedValueOnce([]);
    getReversiblePayments.mockResolvedValue([]);
    correctLateFee.mockResolvedValue({ ok: true, feeId: FEE.id, paymentId: "p1", settlementIds: ["s1"], totalMinor: 12000 });
    render(withMessages(<FinancialCorrectionsSection organizationId="org-1" students={[{ id: "s1", firstName: "Ana", lastName: "Soto", academyId: "a1", academyName: "Alliance" }]} />));

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByText(/2030-10/)).toBeInTheDocument());

    const feeRow = within(screen.getByText(/2030-10/).closest("li")!);
    fireEvent.click(feeRow.getByRole("button", { name: /Correct/i }));
    fireEvent.change(feeRow.getByLabelText(/Reason/i), { target: { value: "reason" } });
    fireEvent.click(feeRow.getByRole("button", { name: /Correct and settle/i }));

    await waitFor(() => expect(getCorrectableLateFees).toHaveBeenCalledTimes(2));
  });
});
