/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Package-purchase UI brief §7's two required cross-card tests — this is the FIRST PR with two mounted cards, so
 * these two scenarios can only be proved with BOTH real components mounted together:
 *
 *  1. The two-card simultaneous-recovery test: a stored ORDINARY attempt and a stored PACKAGE attempt exist at the
 *     same time. Each card's own recovery queue must contain only its own entry; each card's own retry/check-status
 *     calls must hit only its own mocked action module; neither entry is cleared or modified by the card that
 *     doesn't own it.
 *  2. The unclassifiable-entry ownership test: a corrupt entry renders ONLY in the ordinary card's own separate
 *     section, with ONLY a status-check control (never a retry); a `notFound` check result leaves it preserved,
 *     byte-identical; the package card's own mount never sees or references it at all.
 */

const recordPayment = vi.fn();
const checkSubmissionOutcome = vi.fn();
const getPayableObligations = vi.fn();
vi.mock("@/lib/dues/payment-entry-actions", () => ({ recordPayment, checkSubmissionOutcome, getPayableObligations }));

const purchasePackage = vi.fn();
const getPackagePlanOptions = vi.fn();
const getFirstAvailablePackageMonth = vi.fn();
vi.mock("@/lib/dues/package-purchase-actions", () => ({ purchasePackage, getPackagePlanOptions, getFirstAvailablePackageMonth }));

const { PaymentEntrySection } = await import("../../src/app/[locale]/(staff)/payments/payment-entry-section");
const { PackagePurchaseSection } = await import("../../src/app/[locale]/(staff)/payments/package-purchase-section");

const ORG_ID = "org-1";
const USER_ID = "user-1";
const STUDENTS = [{ id: "student-1", firstName: "Ana", lastName: "Soto", academyId: "academy-1", academyName: "Alliance" }];

function renderBothCards() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-testid="ordinary-card">
        <PaymentEntrySection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} organizationRole="ADMIN" plansHref="/en/payments/plans" />
      </div>
      <div data-testid="package-card">
        <PackagePurchaseSection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} plansHref="/en/payments/plans" />
      </div>
    </NextIntlClientProvider>,
  );
}

const ORDINARY_PAYLOAD = {
  operation: "ORDINARY",
  studentId: "student-1",
  obligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 6, day: 10 },
  tender: { currency: "USD", amount: "100.00" },
  method: "EFECTIVO",
};

const PACKAGE_PAYLOAD = {
  operation: "PACKAGE",
  studentId: "student-1",
  planTermsId: "terms-1",
  requestedStartMonth: { year: 2027, month: 6 },
  existingObligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 6, day: 10 },
  tender: { currency: "USD", amount: "370.00" },
  method: "EFECTIVO",
};

beforeEach(() => {
  window.localStorage.clear();
  recordPayment.mockReset();
  checkSubmissionOutcome.mockReset();
  getPayableObligations.mockReset();
  purchasePackage.mockReset();
  getPackagePlanOptions.mockReset();
  getFirstAvailablePackageMonth.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("two-card simultaneous recovery (brief §7)", () => {
  it("each card's own recovery queue contains only its own entry, calls hit only its own action module, neither clears the other's entry", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-ordinary`, JSON.stringify(ORDINARY_PAYLOAD));
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-package`, JSON.stringify(PACKAGE_PAYLOAD));

    // Both remain uncertain (notFound) — neither should be cleared, and each card's own check must target only its
    // own submissionId.
    checkSubmissionOutcome.mockResolvedValue({ status: "notFound" });

    renderBothCards();

    await waitFor(() => expect(checkSubmissionOutcome).toHaveBeenCalledTimes(2));
    const calledWith = checkSubmissionOutcome.mock.calls.map((c) => c[1]).sort();
    expect(calledWith).toEqual(["sub-ordinary", "sub-package"]);

    // Both entries survive, untouched — neither card cleared the other's (or even its own, since notFound preserves).
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-ordinary`)).toBe(JSON.stringify(ORDINARY_PAYLOAD));
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-package`)).toBe(JSON.stringify(PACKAGE_PAYLOAD));

    // Each card renders its own blocked-recovery UI, independent of the other.
    const ordinaryCard = within(screen.getByTestId("ordinary-card"));
    const packageCard = within(screen.getByTestId("package-card"));
    await waitFor(() => expect(ordinaryCard.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());
    await waitFor(() => expect(packageCard.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());

    // Retrying from the ordinary card's own "Retry safely" must call recordPayment, never purchasePackage.
    recordPayment.mockResolvedValueOnce({ ok: false, error: "notActive" });
    fireEvent.click(ordinaryCard.getByRole("button", { name: /Retry safely/i }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(purchasePackage).not.toHaveBeenCalled();
    // The ordinary retry's own FormData carries the ordinary submissionId, never the package one.
    const ordinaryRetryFormData = recordPayment.mock.calls[0][2] as FormData;
    expect(ordinaryRetryFormData.get("submissionId")).toBe("sub-ordinary");

    // Retrying from the package card's own "Retry safely" must call purchasePackage, never recordPayment again.
    purchasePackage.mockResolvedValueOnce({ ok: false, error: "notActive" });
    fireEvent.click(packageCard.getByRole("button", { name: /Retry safely/i }));
    await waitFor(() => expect(purchasePackage).toHaveBeenCalledTimes(1));
    expect(recordPayment).toHaveBeenCalledTimes(1); // unchanged — the package retry never called the ordinary action
    const packageRetryFormData = purchasePackage.mock.calls[0][2] as FormData;
    expect(packageRetryFormData.get("submissionId")).toBe("sub-package");

    // The package card's own student picker never opened (confirming it mounted independently and never touched
    // the ordinary card's own fields).
    expect(getPackagePlanOptions).not.toHaveBeenCalled();
  });

  it("a PACKAGE entry is never read by the ordinary card's own recovery queue, and vice versa, when only one of the two exists", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-package-only`, JSON.stringify(PACKAGE_PAYLOAD));
    checkSubmissionOutcome.mockResolvedValue({ status: "notFound" });

    renderBothCards();

    await waitFor(() => expect(checkSubmissionOutcome).toHaveBeenCalledTimes(1));
    expect(checkSubmissionOutcome).toHaveBeenCalledWith(ORG_ID, "sub-package-only");

    // The ordinary card has nothing of its own to recover — its form renders normally, unblocked.
    const ordinaryCard = within(screen.getByTestId("ordinary-card"));
    await waitFor(() => expect(ordinaryCard.getByLabelText(/Student/i)).toBeInTheDocument());
  });
});

describe("unclassifiable-entry ownership (brief §7)", () => {
  it("a corrupt entry renders ONLY in the ordinary card's own separate section, with only a status-check control, and the package card never references it", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt`, "not even json {{{");

    renderBothCards();

    const ordinaryCard = within(screen.getByTestId("ordinary-card"));
    const packageCard = within(screen.getByTestId("package-card"));

    await waitFor(() => expect(ordinaryCard.getByText(/Unrecognized attempt found/i)).toBeInTheDocument());
    // Only a status-check control — never a retry (there is no validated payload to resend).
    expect(ordinaryCard.getByRole("button", { name: /Check status/i })).toBeInTheDocument();
    expect(ordinaryCard.queryByRole("button", { name: /Retry safely/i })).toBeNull();

    // The package card never sees or renders this entry at all — it's not its own operation, and it's not the
    // "unclassifiable" bucket's owner either way.
    expect(packageCard.queryByText(/Unrecognized attempt found/i)).toBeNull();
    expect(getPackagePlanOptions).not.toHaveBeenCalled();
    expect(checkSubmissionOutcome).not.toHaveBeenCalled(); // nothing auto-checks an unclassifiable entry on mount

    // A notFound check result PRESERVES it, byte-identical — never auto-cleared.
    checkSubmissionOutcome.mockResolvedValueOnce({ status: "notFound" });
    fireEvent.click(ordinaryCard.getByRole("button", { name: /Check status/i }));
    await waitFor(() => expect(checkSubmissionOutcome).toHaveBeenCalledTimes(1));
    expect(checkSubmissionOutcome).toHaveBeenCalledWith(ORG_ID, "sub-corrupt");
    await waitFor(() => expect(ordinaryCard.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt`)).toBe("not even json {{{");

    // The main ordinary form's own RENDERING/status-check/cleanup stays independent of `phase`/`locked`, as before —
    // only the SUBMIT action is now gated on this entry's unresolved state (proven in the describe block below).
    expect(ordinaryCard.getByLabelText(/Student/i)).toBeInTheDocument();
  });

  it("a committed check result clears the entry's storage and renders the real outcome inline", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-2`, "{{{not json");
    renderBothCards();
    const ordinaryCard = within(screen.getByTestId("ordinary-card"));
    await waitFor(() => expect(ordinaryCard.getByText(/Unrecognized attempt found/i)).toBeInTheDocument());

    checkSubmissionOutcome.mockResolvedValueOnce({ status: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } });
    fireEvent.click(ordinaryCard.getByRole("button", { name: /Check status/i }));

    await waitFor(() => expect(ordinaryCard.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-2`)).toBeNull();
  });
});

describe("cross-card submission blocking while an unclassifiable entry is unresolved", () => {
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
  const TODAY_LOCAL = { year: 2027, month: 6, day: 15 };

  /** Fills BOTH cards' forms to the point where each would otherwise be submittable — any remaining `disabled` on
   * either submit button can only be this cross-card block, nothing else. */
  async function fillBothFormsToSubmittable() {
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [DEBT_ITEM], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    getPackagePlanOptions.mockResolvedValue({ ok: true, plans: [PLAN] });
    getFirstAvailablePackageMonth.mockResolvedValue({ ok: true, month: { year: 2027, month: 6 } });

    const ordinaryCard = within(screen.getByTestId("ordinary-card"));
    const packageCard = within(screen.getByTestId("package-card"));

    fireEvent.change(ordinaryCard.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(ordinaryCard.getAllByRole("checkbox").length).toBeGreaterThan(0));
    fireEvent.change(ordinaryCard.getByLabelText(/Amount received/i), { target: { value: "100.00" } });

    fireEvent.change(packageCard.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(packageCard.getByLabelText(/Package/i)).toBeInTheDocument());
    fireEvent.change(packageCard.getByLabelText(/Package/i), { target: { value: PLAN.planTermsId } });
    await waitFor(() => expect(packageCard.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.change(packageCard.getByLabelText(/Amount received/i), { target: { value: "370.00" } });

    return { ordinaryCard, packageCard };
  }

  it("a corrupt entry present at mount blocks BOTH cards' submit — neither write action is ever called", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-block`, "not even json {{{");
    renderBothCards();
    const { ordinaryCard, packageCard } = await fillBothFormsToSubmittable();

    expect(ordinaryCard.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect(packageCard.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
    expect(ordinaryCard.getByText(/can't be submitted until this is resolved/i)).toBeInTheDocument();
    expect(packageCard.getByText(/prior attempt needs review/i)).toBeInTheDocument();

    fireEvent.click(ordinaryCard.getByRole("button", { name: /Record payment/i }));
    fireEvent.click(packageCard.getByRole("button", { name: /Purchase package/i }));
    expect(recordPayment).not.toHaveBeenCalled();
    expect(purchasePackage).not.toHaveBeenCalled();
  });

  it("a failed/notFound status-check on the corrupt entry keeps BOTH cards still blocked", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-block2`, "not even json {{{");
    renderBothCards();
    const { ordinaryCard, packageCard } = await fillBothFormsToSubmittable();

    checkSubmissionOutcome.mockResolvedValueOnce({ status: "notFound" });
    fireEvent.click(ordinaryCard.getByRole("button", { name: /Check status/i }));
    await waitFor(() => expect(ordinaryCard.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());

    expect(ordinaryCard.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect(packageCard.getByRole("button", { name: /Purchase package/i })).toBeDisabled();
    expect(recordPayment).not.toHaveBeenCalled();
    expect(purchasePackage).not.toHaveBeenCalled();
  });

  it("a committed outcome plus successful cleanup restores BOTH cards' availability, without either card performing a financial write", async () => {
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-resolve`, "not even json {{{");
    renderBothCards();
    const { ordinaryCard, packageCard } = await fillBothFormsToSubmittable();

    expect(ordinaryCard.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect(packageCard.getByRole("button", { name: /Purchase package/i })).toBeDisabled();

    checkSubmissionOutcome.mockResolvedValueOnce({ status: "committed", outcome: { kind: "payment", paymentId: "p-resolved", currentlyReversed: false } });
    fireEvent.click(ordinaryCard.getByRole("button", { name: /Check status/i }));
    await waitFor(() => expect(ordinaryCard.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-corrupt-resolve`)).toBeNull();

    await waitFor(() => expect(packageCard.getByRole("button", { name: /Purchase package/i })).not.toBeDisabled());
    expect(ordinaryCard.queryByText(/can't be submitted until this is resolved/i)).toBeNull();
    expect(packageCard.queryByText(/prior attempt needs review/i)).toBeNull();

    // Only ever a status check happened — neither card performed a financial write to get here.
    expect(checkSubmissionOutcome).toHaveBeenCalledTimes(1);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(purchasePackage).not.toHaveBeenCalled();
  });
});
