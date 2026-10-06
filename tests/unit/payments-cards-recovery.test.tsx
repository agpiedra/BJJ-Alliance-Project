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

    // The main ordinary form is NOT blocked by this — it's a separate section, independent of `phase`/`locked`.
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
