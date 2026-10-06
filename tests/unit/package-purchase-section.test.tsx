/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Package-purchase UI brief §8 ("PR 2" tier 5): the REAL component-level proof for the package card, mirroring
 * `payment-entry-section.test.tsx`'s own depth/style exactly — real `localStorage`, real user events, mocking ONLY
 * the action modules (`payment-entry-actions.ts` for the shared `checkSubmissionOutcome`/`getPayableObligations`,
 * `package-purchase-actions.ts` for the package-specific actions). The three named regression classes from the
 * ordinary card's own correction rounds are reproduced here against the package card: a pre-arbitration refusal
 * during an active recovery retry preserves the stored attempt; a clear-after-write failure blocks a new entry and
 * offers "Finish cleanup"; the stale-selection (`staleTerms`) reconciliation fetch is genuinely awaited, locked, and
 * discriminator-protected.
 */

const purchasePackage = vi.fn();
const getPackagePlanOptions = vi.fn();
const getFirstAvailablePackageMonth = vi.fn();
const checkSubmissionOutcome = vi.fn();
const getPayableObligations = vi.fn();

vi.mock("@/lib/dues/package-purchase-actions", () => ({ purchasePackage, getPackagePlanOptions, getFirstAvailablePackageMonth }));
vi.mock("@/lib/dues/payment-entry-actions", () => ({ checkSubmissionOutcome, getPayableObligations }));

const { PackagePurchaseSection } = await import("../../src/app/[locale]/(staff)/payments/package-purchase-section");

const STUDENTS = [
  { id: "student-1", firstName: "Ana", lastName: "Soto", academyId: "academy-1", academyName: "Alliance" },
  { id: "student-2", firstName: "Beto", lastName: "Mora", academyId: "academy-1", academyName: "Alliance" },
];
const ORG_ID = "org-1";
const USER_ID = "user-1";
const TODAY_LOCAL = { year: 2027, month: 6, day: 15 };

function renderSection(props: Partial<React.ComponentProps<typeof PackagePurchaseSection>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PackagePurchaseSection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} plansHref="/en/payments/plans" {...props} />
    </NextIntlClientProvider>,
  );
}

const PLAN = { planId: "plan-1", planTermsId: "terms-1", planName: "3-Month Package", monthsCovered: 3, priceAmount: "270.00", currency: "USD" as const };

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

async function selectStudentPlanAndFillAmount(
  plans = [PLAN],
  debt: typeof DEBT_ITEM[] = [DEBT_ITEM],
  mixedCurrency = false,
  advisoryMonth: { year: number; month: number } | null = { year: 2027, month: 6 },
) {
  getPackagePlanOptions.mockResolvedValue({ ok: true, plans });
  getFirstAvailablePackageMonth.mockResolvedValue({ ok: true, month: advisoryMonth });
  getPayableObligations.mockResolvedValue({ ok: true, obligations: debt, mixedCurrency, todayLocal: TODAY_LOCAL });
  fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
  await waitFor(() => expect(screen.getByLabelText(/Package/i)).toBeInTheDocument());
  if (plans.length > 0) fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: plans[0].planTermsId } });
  await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "370.00" } });
}

beforeEach(() => {
  window.localStorage.clear();
  purchasePackage.mockReset();
  getPackagePlanOptions.mockReset();
  getFirstAvailablePackageMonth.mockReset();
  checkSubmissionOutcome.mockReset();
  getPayableObligations.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("basic render and submission", () => {
  it("a fresh package purchase renders success copy and clears the stored attempt", async () => {
    purchasePackage.mockResolvedValue({ ok: true, obligationId: "pkgob1", paymentId: "p1", settlementIds: ["s1"], totalMinor: 37000 });
    renderSection();
    await selectStudentPlanAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(screen.getByText("Package purchased.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
  });

  it("the submitted form data carries ALL outstanding debt ids forced, not a user selection", async () => {
    purchasePackage.mockResolvedValue({ ok: true, obligationId: "pkgob1", paymentId: "p1", settlementIds: ["s1"], totalMinor: 37000 });
    renderSection();
    const olderDebt = { ...DEBT_ITEM, obligationId: "ob-older", coverageMonth: 4 };
    const newerDebt = { ...DEBT_ITEM, obligationId: "ob-newer", coverageMonth: 5 };
    await selectStudentPlanAndFillAmount([PLAN], [olderDebt, newerDebt]);

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(purchasePackage).toHaveBeenCalledTimes(1));
    const formData = purchasePackage.mock.calls[0][2] as FormData;
    expect(formData.getAll("existingObligationIds").sort()).toEqual(["ob-newer", "ob-older"]);
    expect(formData.get("planTermsId")).toBe(PLAN.planTermsId);
  });

  it("a mixed-currency debt response blocks submission, exactly like the ordinary card", async () => {
    renderSection();
    getPackagePlanOptions.mockResolvedValue({ ok: true, plans: [PLAN] });
    getFirstAvailablePackageMonth.mockResolvedValue({ ok: true, month: null });
    const usd = { ...DEBT_ITEM, currency: "USD" as const };
    const crc = { ...DEBT_ITEM, obligationId: "ob-2", currency: "CRC" as const };
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [usd, crc], mixedCurrency: true, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });

    await waitFor(() => expect(screen.getByText(/owes in more than one currency/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: PLAN.planTermsId } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "370.00" } });
    expect(screen.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
  });

  it("shows a per-currency estimated total combining existing debt and the package's own price, labeled as non-authoritative", async () => {
    renderSection();
    await selectStudentPlanAndFillAmount();
    // DEBT_ITEM is 100.00 USD, PLAN is 270.00 USD -> 370.00 USD combined.
    expect(screen.getByText(/370\.00 USD/)).toBeInTheDocument();
    expect(screen.getByText(/not an authoritative quote/i)).toBeInTheDocument();
  });
});

describe("regression (1): a pre-arbitration refusal during an ACTIVE recovery retry preserves the stored attempt, never shown as success", () => {
  it("a rejected promise, then a retry-safely call returning notActive: STAYS locked, the stored entry is byte-identical", async () => {
    purchasePackage.mockRejectedValueOnce(new TypeError("network error"));
    renderSection();
    await selectStudentPlanAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());

    expect(window.localStorage.length).toBe(1);
    const keyAfterReject = storedKeys()[0];
    const valueAfterReject = window.localStorage.getItem(keyAfterReject);

    purchasePackage.mockResolvedValueOnce({ ok: false, error: "notActive" });
    fireEvent.click(screen.getByRole("button", { name: /Retry safely/i }));

    await waitFor(() => expect(screen.getByText(/can't confirm this package's status right now/i)).toBeInTheDocument());

    expect(screen.queryByText("Package purchased.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Record another/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Retry safely/i })).toBeInTheDocument();

    expect(window.localStorage.length).toBe(1);
    expect(storedKeys()[0]).toBe(keyAfterReject);
    expect(window.localStorage.getItem(keyAfterReject)).toBe(valueAfterReject);

    expect(purchasePackage).toHaveBeenCalledTimes(2);
    const firstFormData = purchasePackage.mock.calls[0][2] as FormData;
    const secondFormData = purchasePackage.mock.calls[1][2] as FormData;
    expect(secondFormData.get("submissionId")).toBe(firstFormData.get("submissionId"));
  });
});

describe("regression (2): a clear-after-write failure blocks a new entry and offers 'Finish cleanup'", () => {
  it("after a fresh SUCCESS, a clearAttempt failure blocks the form, offers Finish cleanup, and resetting the draft waits for it", async () => {
    purchasePackage.mockResolvedValue({ ok: true, obligationId: "pkgob1", paymentId: "p1", settlementIds: ["s1"], totalMinor: 37000 });
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage inaccessible");
    });
    renderSection();
    await selectStudentPlanAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(screen.getByText(/couldn't finish clearing the local draft/i)).toBeInTheDocument());
    expect(screen.queryByText("Package purchased.")).toBeNull();
    expect(window.localStorage.length).toBe(1);
    expect(screen.queryByLabelText(/Student/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Finish cleanup/i }));

    await waitFor(() => expect(screen.getByText("Package purchased.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(purchasePackage).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("regression (3): staleTerms reconciliation is genuinely awaited, locked, and discriminator-protected", () => {
  it("submit stays disabled for the ENTIRE duration of the pending plan/terms re-fetch, then clears the stale selection", async () => {
    renderSection();
    await selectStudentPlanAndFillAmount();

    const reconcile = deferred<Awaited<ReturnType<typeof getPackagePlanOptions>>>();
    getPackagePlanOptions.mockReturnValueOnce(reconcile.promise);
    purchasePackage.mockResolvedValueOnce({ ok: false, error: "staleTerms" });

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));
    await waitFor(() => expect(screen.getByText(/price has changed since you selected it/i)).toBeInTheDocument());

    // The reconciliation fetch is still pending — submit must stay disabled the whole time, and no second write fires.
    expect(screen.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
    expect(purchasePackage).toHaveBeenCalledTimes(1);

    const newerPlan = { ...PLAN, planTermsId: "terms-2", priceAmount: "300.00" };
    reconcile.resolve({ ok: true, plans: [newerPlan] });
    await waitFor(() => expect(screen.getByRole("button", { name: /Purchase package/i })).toBeDisabled());
    // The previously-selected terms id was cleared — the owner must explicitly re-confirm the new price.
    expect((screen.getByLabelText(/Package/i) as HTMLSelectElement).value).toBe("");
  });

  it("a rejected plan/terms re-fetch is handled (never an unhandled rejection) and offers a retry", async () => {
    renderSection();
    await selectStudentPlanAndFillAmount();

    getPackagePlanOptions.mockRejectedValueOnce(new Error("network down"));
    purchasePackage.mockResolvedValueOnce({ ok: false, error: "staleTerms" });

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^Retry$/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
  });
});

describe("coverageGap copy never claims to name which month failed, and may show the advisory guess", () => {
  it("shows the generic conflict message plus the UI's own labeled advisory guess", async () => {
    renderSection();
    await selectStudentPlanAndFillAmount([PLAN], [DEBT_ITEM], false, { year: 2027, month: 8 });
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    purchasePackage.mockResolvedValueOnce({ ok: false, error: "coverageGap" });

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(screen.getByText(/conflicts with existing coverage/i)).toBeInTheDocument());
    expect(screen.getByText(/our own best guess.*2027-08/i)).toBeInTheDocument();
  });
});

describe("advisory-month races: current edit/request identity, never a stale response", () => {
  it("a late advisory-month response never overwrites a start month the owner already typed", async () => {
    renderSection();
    const advisory = deferred<Awaited<ReturnType<typeof getFirstAvailablePackageMonth>>>();
    getPackagePlanOptions.mockResolvedValue({ ok: true, plans: [PLAN] });
    getFirstAvailablePackageMonth.mockReturnValueOnce(advisory.promise);
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Package/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: PLAN.planTermsId } });

    // The owner types a custom start month BEFORE the advisory fetch (still pending) resolves.
    fireEvent.change(screen.getByLabelText(/Start month/i), { target: { value: "2027-09" } });

    advisory.resolve({ ok: true, month: { year: 2027, month: 6 } });
    await new Promise((r) => setTimeout(r, 0));

    expect((screen.getByLabelText(/Start month/i) as HTMLInputElement).value).toBe("2027-09");

    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "370.00" } });
    purchasePackage.mockResolvedValueOnce({ ok: true, obligationId: "pkgob1", paymentId: "p1", settlementIds: ["s1"], totalMinor: 37000 });
    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(purchasePackage).toHaveBeenCalledTimes(1));
    const formData = purchasePackage.mock.calls[0][2] as FormData;
    expect(formData.get("requestedStartMonth")).toBe("2027-09");
  });

  it("a stale advisory-month response for student A never applies after switching to student B (initial fetch)", async () => {
    renderSection();
    const advisoryA = deferred<Awaited<ReturnType<typeof getFirstAvailablePackageMonth>>>();
    getPackagePlanOptions.mockResolvedValue({ ok: true, plans: [PLAN] });
    getFirstAvailablePackageMonth.mockReturnValueOnce(advisoryA.promise);
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });

    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Package/i)).toBeInTheDocument());

    // Switch to student B before A's advisory fetch resolves — B gets its own, different advisory.
    getFirstAvailablePackageMonth.mockResolvedValueOnce({ ok: true, month: { year: 2027, month: 11 } });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-2" } });
    await waitFor(() => expect((screen.getByLabelText(/Start month/i) as HTMLInputElement).value).toBe("2027-11"));

    // A's stale advisory now resolves — must be discarded, never overwriting B's already-applied suggestion.
    advisoryA.resolve({ ok: true, month: { year: 2027, month: 6 } });
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByLabelText(/Start month/i) as HTMLInputElement).value).toBe("2027-11");

    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: PLAN.planTermsId } });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "370.00" } });
    purchasePackage.mockResolvedValueOnce({ ok: true, obligationId: "pkgob1", paymentId: "p1", settlementIds: ["s1"], totalMinor: 37000 });
    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));

    await waitFor(() => expect(purchasePackage).toHaveBeenCalledTimes(1));
    const formData = purchasePackage.mock.calls[0][2] as FormData;
    expect(formData.get("studentId")).toBe("student-2");
  });

  it("a stale coverageGap follow-up advisory for student A never applies after switching to student B", async () => {
    renderSection();
    await selectStudentPlanAndFillAmount();

    const followUpA = deferred<Awaited<ReturnType<typeof getFirstAvailablePackageMonth>>>();
    // The main mount-fetch for student-1 already resolved inside selectStudentPlanAndFillAmount with month 2027-06;
    // this is the SEPARATE follow-up fired only after a coverageGap refusal.
    getFirstAvailablePackageMonth.mockReturnValueOnce(followUpA.promise);
    purchasePackage.mockResolvedValueOnce({ ok: false, error: "coverageGap" });
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });

    fireEvent.click(screen.getByRole("button", { name: /Purchase package/i }));
    await waitFor(() => expect(screen.getByText(/conflicts with existing coverage/i)).toBeInTheDocument());

    // Switch to student B before A's coverageGap follow-up resolves.
    getPackagePlanOptions.mockResolvedValueOnce({ ok: true, plans: [PLAN] });
    getFirstAvailablePackageMonth.mockResolvedValueOnce({ ok: true, month: { year: 2027, month: 12 } });
    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-2" } });
    await waitFor(() => expect(screen.getByText(/Suggested start month: 2027-12/i)).toBeInTheDocument());

    // A's stale coverageGap follow-up now resolves with a DIFFERENT month — must never overwrite B's own suggestion.
    followUpA.resolve({ ok: true, month: { year: 2027, month: 7 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Suggested start month: 2027-12/i)).toBeInTheDocument();
    expect(screen.queryByText(/Suggested start month: 2027-07/i)).toBeNull();
  });
});

describe("reload-recovery mount check (own operation only)", () => {
  it("a stored PACKAGE attempt resolving to a committed outcome on mount clears it and renders the original outcome", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-recovered`,
      JSON.stringify({
        operation: "PACKAGE",
        studentId: "student-1",
        planTermsId: "terms-1",
        requestedStartMonth: { year: 2027, month: 6 },
        existingObligationIds: ["ob-1"],
        receivedOn: { year: 2027, month: 6, day: 10 },
        tender: { currency: "USD", amount: "370.00" },
        method: "EFECTIVO",
      }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p-original", currentlyReversed: false } });

    renderSection();

    await waitFor(() => expect(screen.getByText("Package purchased.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(purchasePackage).not.toHaveBeenCalled();
  });

  it("a stored ORDINARY attempt is never read or acted on by the package card (ignored as 'otherOperations')", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-ordinary`,
      JSON.stringify({ operation: "ORDINARY", studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 6, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );

    renderSection();

    await waitFor(() => expect(screen.getByLabelText(/Student/i)).toBeInTheDocument());
    expect(checkSubmissionOutcome).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(1); // untouched
  });
});
