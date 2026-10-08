/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.6 (PR 2): `PaymentsTable`'s own `ledgerActive` prop hides the two
 * mutation controls that ultimately call the legacy `recordPayment`/`markPaymentPaid` (which refuse server-side
 * regardless) — "Mark as paid" on a PENDING/OVERDUE row, and "Edit" on a PROMO_OR_EXEMPT row (falling back to
 * the same read-only "View receipt" a non-recording role already gets). The status table/pill rendering itself
 * (`statusLabel`, `pillVariantFor`) is untouched either way — only these two write-triggering buttons are gated.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/payments/payment-actions", () => ({ recordPayment: vi.fn(), markPaymentPaid: vi.fn() }));

const { PaymentsTable } = await import("../../src/app/[locale]/(staff)/payments/payments-table");

function pendingRowOn(bucket: "PENDING" | "OVERDUE") {
  return {
    studentId: "student-pending",
    firstName: "Pat",
    lastName: "Overdue",
    homeAcademyId: "academy-1",
    homeAcademyName: "Heredia",
    bucket,
    period: null,
  };
}

function promoRow() {
  return {
    studentId: "student-promo",
    firstName: "Alice",
    lastName: "Promo",
    homeAcademyId: "academy-1",
    homeAcademyName: "Heredia",
    bucket: "PROMO_OR_EXEMPT" as const,
    period: {
      id: "period-1",
      year: 2026,
      month: 9,
      status: "PROMO" as const,
      planId: "plan-monthly",
      planName: "Monthly",
      amount: 0,
      currency: "USD" as const,
      method: null,
      notes: null,
      promoName: "Scholarship",
      promoReason: null,
      promoRecurring: false,
      recordedById: "user-1",
      recordedByEmail: "owner@example.com",
      recordedAt: new Date("2026-09-20T12:00:00Z"),
    },
  };
}

function renderTable(row: ReturnType<typeof pendingRowOn> | ReturnType<typeof promoRow>, ledgerActive: boolean) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentsTable
        organizationId="org-1"
        rows={[row]}
        plans={[]}
        academies={[{ id: "academy-1", name: "Heredia" }]}
        currentYear={2026}
        currentMonth={9}
        canRecordPayments={true}
        ledgerActive={ledgerActive}
        locale="en"
      />
    </NextIntlClientProvider>,
  );
}

describe("PaymentsTable: ledgerActive hides the legacy mutation controls", () => {
  afterEach(cleanup);

  it("REQUIRED: a PENDING row shows 'Mark paid' when inactive (unchanged existing behavior)", () => {
    renderTable(pendingRowOn("PENDING"), false);
    expect(screen.getByRole("button", { name: "Mark paid" })).toBeTruthy();
  });

  it("REQUIRED: the same PENDING row has NO 'Mark paid' button once the ledger is active", () => {
    renderTable(pendingRowOn("PENDING"), true);
    expect(screen.queryByRole("button", { name: "Mark paid" })).toBeNull();
  });

  it("REQUIRED: an OVERDUE row behaves identically to PENDING — no 'Mark paid' once active", () => {
    renderTable(pendingRowOn("OVERDUE"), true);
    expect(screen.queryByRole("button", { name: "Mark paid" })).toBeNull();
  });

  it("REQUIRED: a PROMO_OR_EXEMPT row shows 'Edit' when inactive (unchanged existing behavior)", () => {
    renderTable(promoRow(), false);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View receipt" })).toBeNull();
  });

  it("REQUIRED: the same PROMO_OR_EXEMPT row falls back to the read-only 'View receipt' once active — never 'Edit'", () => {
    renderTable(promoRow(), true);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "View receipt" })).toBeTruthy();
  });
});
