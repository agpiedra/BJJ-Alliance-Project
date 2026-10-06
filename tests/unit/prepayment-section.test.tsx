/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Monthly-prepayment UI brief §8 tier 5: the REAL component-level proof for the prepayment card, mirroring
 * `package-purchase-section.test.tsx`'s own depth/style exactly — real `localStorage`, real user events, mocking
 * ONLY the action modules. The three named regression classes from the ordinary/package cards' own correction
 * rounds are reproduced here: a pre-arbitration refusal during an active recovery retry preserves the stored
 * attempt; a clear-after-write failure blocks a new entry and offers "Finish cleanup"; the stale-selection
 * (`coverageGap`) reconciliation fetch is genuinely awaited, locked, and discriminator-protected.
 */

const prepayMonths = vi.fn();
const getFirstAvailablePrepaymentMonth = vi.fn();
const getMonthPrices = vi.fn();
const checkSubmissionOutcome = vi.fn();
const getPayableObligations = vi.fn();

vi.mock("@/lib/dues/prepayment-actions", () => ({ prepayMonths, getFirstAvailablePrepaymentMonth, getMonthPrices }));
vi.mock("@/lib/dues/payment-entry-actions", () => ({ checkSubmissionOutcome, getPayableObligations }));

const { PrepaymentSection } = await import("../../src/app/[locale]/(staff)/payments/prepayment-section");

const STUDENTS = [
  { id: "student-1", firstName: "Ana", lastName: "Soto", academyId: "academy-1", academyName: "Alliance" },
  { id: "student-2", firstName: "Beto", lastName: "Mora", academyId: "academy-1", academyName: "Alliance" },
];
const ORG_ID = "org-1";
const USER_ID = "user-1";
const TODAY_LOCAL = { year: 2027, month: 6, day: 15 };

function renderSection(props: Partial<React.ComponentProps<typeof PrepaymentSection>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PrepaymentSection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} plansHref="/en/payments/plans" {...props} />
    </NextIntlClientProvider>,
  );
}

const DEBT_ITEM = {
  obligationId: "ob-1",
  type: "MONTHLY" as const,
  currency: "USD" as const,
  coverageYear: 2027,
  coverageMonth: 5,
  settled: false as const,
  outstandingAmountMinor: 10000,
  outstandingFeeMinor: 0,
  dueOn: "2027-05-20",
  pastGrace: false,
};

const JULY_PRICE = { month: { year: 2027, month: 7 }, priceAmount: "100.00", currency: "USD" as const };

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k) keys.push(k);
  }
  return keys;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Selects student-1 (auto-seeding the month list with the advisory's one month, 2027-07), lets the per-month price
 * resolve, and fills the amount field — the prepayment-card equivalent of the package card's own
 * `selectStudentPlanAndFillAmount`. */
async function selectStudentAndFillAmount(
  debt: typeof DEBT_ITEM[] = [DEBT_ITEM],
  mixedCurrency = false,
  advisoryMonth: { year: number; month: number } | null = { year: 2027, month: 7 },
  horizonEnd: { year: number; month: number } | null = { year: 2027, month: 12 },
) {
  getFirstAvailablePrepaymentMonth.mockResolvedValue({ ok: true, month: advisoryMonth, horizonEnd });
  getPayableObligations.mockResolvedValue({ ok: true, obligations: debt, mixedCurrency, todayLocal: TODAY_LOCAL });
  getMonthPrices.mockResolvedValue({ ok: true, prices: advisoryMonth ? [JULY_PRICE] : [] });
  fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
  await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
  if (advisoryMonth) await waitFor(() => expect(screen.getByText(/100\.00 USD/)).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "200.00" } });
}

beforeEach(() => {
  window.localStorage.clear();
  prepayMonths.mockReset();
  getFirstAvailablePrepaymentMonth.mockReset();
  getMonthPrices.mockReset();
  checkSubmissionOutcome.mockReset();
  getPayableObligations.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("basic render and submission", () => {
  it("a fresh prepayment renders success copy and clears the stored attempt", async () => {
    prepayMonths.mockResolvedValue({ ok: true, obligationIds: ["pob1"], paymentId: "p1", settlementIds: ["s1"], totalMinor: 20000 });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));

    await waitFor(() => expect(screen.getByText("Prepayment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
  });

  it("the submitted form data carries ALL outstanding debt ids forced, not a user selection — regardless of how many months are selected", async () => {
    prepayMonths.mockResolvedValue({ ok: true, obligationIds: ["pob1"], paymentId: "p1", settlementIds: ["s1"], totalMinor: 20000 });
    renderSection();
    const olderDebt = { ...DEBT_ITEM, obligationId: "ob-older", coverageMonth: 4 };
    const newerDebt = { ...DEBT_ITEM, obligationId: "ob-newer", coverageMonth: 5 };
    await selectStudentAndFillAmount([olderDebt, newerDebt]);

    // Add a second month — the existing-debt selection must remain the COMPLETE set regardless.
    getMonthPrices.mockResolvedValue({ ok: true, prices: [JULY_PRICE, { month: { year: 2027, month: 8 }, priceAmount: "100.00", currency: "USD" as const }] });
    fireEvent.click(screen.getByRole("button", { name: /Add next month/i }));
    await waitFor(() => expect(screen.getByText("2027-08")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));

    await waitFor(() => expect(prepayMonths).toHaveBeenCalledTimes(1));
    const formData = prepayMonths.mock.calls[0][2] as FormData;
    expect(formData.getAll("existingObligationIds").sort()).toEqual(["ob-newer", "ob-older"]);
    expect(formData.getAll("requestedMonths")).toEqual(["2027-07", "2027-08"]);
  });

  it("a mixed-currency debt response blocks submission, exactly like the ordinary and package cards", async () => {
    renderSection();
    getFirstAvailablePrepaymentMonth.mockResolvedValue({ ok: true, month: { year: 2027, month: 7 }, horizonEnd: { year: 2027, month: 12 } });
    getMonthPrices.mockResolvedValue({ ok: true, prices: [JULY_PRICE] });
    const usd = { ...DEBT_ITEM, currency: "USD" as const };
    const crc = { ...DEBT_ITEM, obligationId: "ob-2", currency: "CRC" as const };
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [usd, crc], mixedCurrency: true, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });

    await waitFor(() => expect(screen.getByText(/owes in more than one currency/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "200.00" } });
    expect(screen.getByRole("button", { name: /Submit prepayment/i })).toBeDisabled();
  });

  it("shows a per-currency estimated total combining existing debt and the selected month's own resolved price, labeled as non-authoritative", async () => {
    renderSection();
    await selectStudentAndFillAmount();
    // DEBT_ITEM is 100.00 USD, July's own price is 100.00 USD -> 200.00 USD combined.
    expect(screen.getByText(/200\.00 USD/)).toBeInTheDocument();
    expect(screen.getByText(/not an authoritative quote/i)).toBeInTheDocument();
  });

  it("'Add next month'/'Remove last month' build a consecutive list, with each month's own independently-resolved price shown", async () => {
    renderSection();
    await selectStudentAndFillAmount();
    expect(screen.getByText("2027-07")).toBeInTheDocument();

    getMonthPrices.mockResolvedValue({ ok: true, prices: [JULY_PRICE, { month: { year: 2027, month: 8 }, priceAmount: "120.00", currency: "USD" as const }] });
    fireEvent.click(screen.getByRole("button", { name: /Add next month/i }));
    await waitFor(() => expect(screen.getByText("2027-08")).toBeInTheDocument());
    expect(screen.getByText(/120\.00 USD/)).toBeInTheDocument();

    getMonthPrices.mockResolvedValue({ ok: true, prices: [JULY_PRICE] });
    fireEvent.click(screen.getByRole("button", { name: /Remove last month/i }));
    await waitFor(() => expect(screen.queryByText("2027-08")).toBeNull());
  });
});

describe("regression (1): a pre-arbitration refusal during an ACTIVE recovery retry preserves the stored attempt, never shown as success", () => {
  it("a rejected promise, then a retry-safely call returning notActive: STAYS locked, the stored entry is byte-identical", async () => {
    prepayMonths.mockRejectedValueOnce(new TypeError("network error"));
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());

    expect(window.localStorage.length).toBe(1);
    const keyAfterReject = storedKeys()[0];
    const valueAfterReject = window.localStorage.getItem(keyAfterReject);

    prepayMonths.mockResolvedValueOnce({ ok: false, error: "notActive" });
    fireEvent.click(screen.getByRole("button", { name: /Retry safely/i }));

    await waitFor(() => expect(screen.getByText(/can't confirm this prepayment's status right now/i)).toBeInTheDocument());

    expect(screen.queryByText("Prepayment recorded.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Record another/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Retry safely/i })).toBeInTheDocument();

    expect(window.localStorage.length).toBe(1);
    expect(storedKeys()[0]).toBe(keyAfterReject);
    expect(window.localStorage.getItem(keyAfterReject)).toBe(valueAfterReject);

    expect(prepayMonths).toHaveBeenCalledTimes(2);
    const firstFormData = prepayMonths.mock.calls[0][2] as FormData;
    const secondFormData = prepayMonths.mock.calls[1][2] as FormData;
    expect(secondFormData.get("submissionId")).toBe(firstFormData.get("submissionId"));
  });
});

describe("regression (2): a clear-after-write failure blocks a new entry and offers 'Finish cleanup'", () => {
  it("after a fresh SUCCESS, a clearAttempt failure blocks the form, offers Finish cleanup, and resetting the draft waits for it", async () => {
    prepayMonths.mockResolvedValue({ ok: true, obligationIds: ["pob1"], paymentId: "p1", settlementIds: ["s1"], totalMinor: 20000 });
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage inaccessible");
    });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));

    await waitFor(() => expect(screen.getByText(/couldn't finish clearing the local draft/i)).toBeInTheDocument());
    expect(screen.queryByText("Prepayment recorded.")).toBeNull();
    expect(window.localStorage.length).toBe(1);
    expect(screen.queryByLabelText(/Student/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Finish cleanup/i }));

    await waitFor(() => expect(screen.getByText("Prepayment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(prepayMonths).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("regression (3): coverageGap reconciliation is genuinely awaited, locked, and discriminator-protected", () => {
  it("submit stays disabled for the ENTIRE duration of the pending debt re-fetch, then refreshes the advisory/horizon", async () => {
    renderSection();
    await selectStudentAndFillAmount();

    const reconcile = deferred<Awaited<ReturnType<typeof getPayableObligations>>>();
    getPayableObligations.mockReturnValueOnce(reconcile.promise);
    const advisoryRefresh = deferred<Awaited<ReturnType<typeof getFirstAvailablePrepaymentMonth>>>();
    getFirstAvailablePrepaymentMonth.mockReturnValueOnce(advisoryRefresh.promise);
    prepayMonths.mockResolvedValueOnce({ ok: false, error: "coverageGap" });

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));
    await waitFor(() => expect(screen.getByText(/conflicts with existing coverage/i)).toBeInTheDocument());

    // The reconciliation fetch is still pending — submit must stay disabled the whole time, and no second write fires.
    expect(screen.getByRole("button", { name: /Submit prepayment/i })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: /Submit prepayment/i })).toBeDisabled();
    expect(prepayMonths).toHaveBeenCalledTimes(1);

    reconcile.resolve({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    advisoryRefresh.resolve({ ok: true, month: { year: 2027, month: 9 }, horizonEnd: { year: 2027, month: 12 } });
    await waitFor(() => expect(screen.getByText(/Suggested first month: 2027-09/i)).toBeInTheDocument());
  });

  it("a rejected debt re-fetch is handled (never an unhandled rejection) and offers a retry", async () => {
    renderSection();
    await selectStudentAndFillAmount();

    getPayableObligations.mockRejectedValueOnce(new Error("network down"));
    prepayMonths.mockResolvedValueOnce({ ok: false, error: "coverageGap" });

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^Retry$/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Submit prepayment/i })).toBeDisabled();
  });
});

describe("coverageGap copy never claims to name which month failed, and may show the advisory guess", () => {
  it("shows the generic conflict message plus the UI's own labeled advisory guess", async () => {
    renderSection();
    await selectStudentAndFillAmount([DEBT_ITEM], false, { year: 2027, month: 8 });
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    prepayMonths.mockResolvedValueOnce({ ok: false, error: "coverageGap" });

    fireEvent.click(screen.getByRole("button", { name: /Submit prepayment/i }));

    await waitFor(() => expect(screen.getByText(/conflicts with existing coverage/i)).toBeInTheDocument());
    expect(screen.getByText(/our own best guess.*2027-08/i)).toBeInTheDocument();
  });
});

describe("prepaymentUnavailable: no policy configured at all", () => {
  it("shows the plain 'not available' copy, never implying a numeric limit was merely exceeded", async () => {
    renderSection();
    getFirstAvailablePrepaymentMonth.mockResolvedValue({ ok: true, month: null, horizonEnd: null });
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });

    await waitFor(() => expect(screen.getByText(/isn't available under this branch's current configuration/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Add next month/i })).toBeDisabled();
  });
});

describe("receivedOn race: current edit identity, never a stale response (the fix this new card builds WITH from the start, unlike the two already-shipped cards)", () => {
  it("a late obligations response never overwrites a received-on date the owner already edited", async () => {
    renderSection();
    const obligations = deferred<Awaited<ReturnType<typeof getPayableObligations>>>();
    getFirstAvailablePrepaymentMonth.mockResolvedValue({ ok: true, month: { year: 2027, month: 7 }, horizonEnd: { year: 2027, month: 12 } });
    getMonthPrices.mockResolvedValue({ ok: true, prices: [JULY_PRICE] });
    getPayableObligations.mockReturnValueOnce(obligations.promise);

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Date received/i)).toBeInTheDocument());

    // The owner edits the received-on date BEFORE the (still pending) obligations fetch resolves.
    fireEvent.change(screen.getByLabelText(/Date received/i), { target: { value: "2027-06-01" } });

    obligations.resolve({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    await new Promise((r) => setTimeout(r, 0));

    expect((screen.getByLabelText(/Date received/i) as HTMLInputElement).value).toBe("2027-06-01");
  });
});

describe("reload-recovery mount check (own operation only)", () => {
  it("a stored PREPAYMENT attempt resolving to a committed outcome on mount clears it and renders the original outcome", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-recovered`,
      JSON.stringify({
        operation: "PREPAYMENT",
        studentId: "student-1",
        requestedMonths: [{ year: 2027, month: 7 }],
        existingObligationIds: ["ob-1"],
        receivedOn: { year: 2027, month: 6, day: 10 },
        tender: { currency: "USD", amount: "200.00" },
        method: "EFECTIVO",
      }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p-original", currentlyReversed: false } });

    renderSection();

    await waitFor(() => expect(screen.getByText("Prepayment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(prepayMonths).not.toHaveBeenCalled();
  });

  it("a stored ORDINARY attempt is never read or acted on by the prepayment card (ignored as 'otherOperations')", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-ordinary`,
      JSON.stringify({ operation: "ORDINARY", studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 6, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );

    renderSection();

    await waitFor(() => expect(screen.getByLabelText(/Student/i)).toBeInTheDocument());
    expect(checkSubmissionOutcome).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(1);
  });
});
