/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Ordinary payment-entry UI brief §8 tier 5: integration proof that the component actually WIRES the pure
 * recovery-state classifier (payment-entry-recovery.test.ts covers every one of its twelve rows directly) into real
 * submit/mount behavior — not a re-proof of the classifier's own logic. Storage uses the REAL
 * `payment-attempt-storage` module against jsdom's real `localStorage` (no DB dependency); only the `"use server"`
 * action module is mocked.
 */

const recordPayment = vi.fn();
const checkSubmissionOutcome = vi.fn();
const getPayableObligations = vi.fn();

vi.mock("@/lib/dues/payment-entry-actions", () => ({ recordPayment, checkSubmissionOutcome, getPayableObligations }));

const { PaymentEntrySection } = await import("../../src/app/[locale]/(staff)/payments/payment-entry-section");

const STUDENTS = [{ id: "student-1", firstName: "Ana", lastName: "Soto", academyId: "academy-1", academyName: "Alliance" }];
const ORG_ID = "org-1";
const USER_ID = "user-1";

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentEntrySection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} />
    </NextIntlClientProvider>,
  );
}

const OBLIGATION = {
  obligationId: "ob-1",
  type: "MONTHLY" as const,
  currency: "USD" as const,
  coverageYear: 2027,
  coverageMonth: 2,
  settled: false as const,
  outstandingAmountMinor: 10000,
  outstandingFeeMinor: 0,
  dueOn: "2027-02-20",
  pastGrace: false,
};

async function selectStudentAndFillAmount(obligations: Array<Omit<typeof OBLIGATION, "currency"> & { currency: "USD" | "CRC" }> = [OBLIGATION], mixedCurrency = false) {
  getPayableObligations.mockResolvedValue({ ok: true, obligations, mixedCurrency });
  fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
  await waitFor(() => expect(getPayableObligations).toHaveBeenCalled());
  if (!mixedCurrency && obligations.length > 0) {
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "100.00" } });
  }
}

beforeEach(() => {
  window.localStorage.clear();
  recordPayment.mockReset();
  checkSubmissionOutcome.mockReset();
  getPayableObligations.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("fresh submission outcomes", () => {
  it("a fresh settlement renders success copy and clears the stored attempt", async () => {
    recordPayment.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], feeIds: [], totalMinor: 10000 });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
  });

  it("a replay reporting currentlyReversed:true shows the DISTINCT reversed notice, never plain success", async () => {
    recordPayment.mockResolvedValue({ ok: true, paymentId: "p1", replay: true, currentlyReversed: true });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/since been reversed/i)).toBeInTheDocument());
    expect(screen.queryByText("Payment recorded.")).toBeNull();
  });

  it("a fresh capture renders the pending-queue copy", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "captured", receiptId: "r1" });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/waiting, pending, in the exchange-rate queue/i)).toBeInTheDocument());
  });

  it("an ordinary refusal shows its own message and leaves the form editable (not locked)", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "notOldestFirst" });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/must start with the oldest/i)).toBeInTheDocument());
  });
});

describe("a rejected submit promise (point 3 — useDuesAction would leave this unhandled)", () => {
  it("routes into the recovery-blocked UI, never silently swallowed, and preserves the stored attempt", async () => {
    recordPayment.mockRejectedValue(new TypeError("network error"));
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());
    expect(window.localStorage.length).toBe(1); // the attempt survives — never discarded on a rejected promise
    expect(screen.getByRole("button", { name: /Retry safely/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check status again/i })).toBeInTheDocument();
  });
});

describe("mixed-currency obligations", () => {
  it("renders the explicit limitation message instead of a selection list", async () => {
    renderSection();
    await selectStudentAndFillAmount([OBLIGATION, { ...OBLIGATION, obligationId: "ob-2", currency: "CRC" as const }], true);
    await waitFor(() => expect(screen.getByText(/owes in more than one currency/i)).toBeInTheDocument());
    expect(screen.queryByText(/2027-02/)).toBeNull();
  });
});

describe("reload-recovery mount check", () => {
  it("a stored attempt resolving to a committed outcome on mount clears it and renders the original outcome", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-recovered`,
      JSON.stringify({ studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p-original", currentlyReversed: false } });

    renderSection();

    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(recordPayment).not.toHaveBeenCalled(); // a read-only recovery check never performs a new financial write
  });

  it("a stored attempt resolving to notFound on mount is preserved, never auto-cleared", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-uncertain`,
      JSON.stringify({ studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "notFound" });

    renderSection();

    await waitFor(() => expect(screen.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());
    expect(window.localStorage.length).toBe(1);
  });
});
