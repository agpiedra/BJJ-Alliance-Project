/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * "A payment on a deactivated plan can still be corrected" is the claim that
 * makes deactivating a plan safe — without it, deactivation freezes every
 * record on the plan forever. The server half (recordPayment allows keeping an
 * inactive plan the payment already sits on) is pinned in
 * tests/integration/payment-plans.test.ts; this pins the UI half: the Pagos edit
 * sheet must OFFER that plan (the picker lists active plans only), selected, and
 * must submit it unchanged. Before this test the rule was a stated design
 * claim with nothing proving it.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/payments/payment-actions", () => ({ recordPayment: vi.fn(), markPaymentPaid: vi.fn() }));

const { recordPayment } = await import("@/lib/payments/payment-actions");
const { PaymentsTable } = await import("../../src/app/[locale]/(staff)/payments/payments-table");

const recordPaymentMock = vi.mocked(recordPayment);

// The only ACTIVE plan; the payment below sits on a plan that is NOT in this list.
const ACTIVE_PLANS = [{ id: "plan-monthly", name: "Monthly", academyId: "academy-1", defaultAmount: null }];

function promoRowOn(planId: string, planName: string) {
  return {
    studentId: "student-1",
    firstName: "Alice",
    lastName: "Verify",
    homeAcademyId: "academy-1",
    homeAcademyName: "Heredia",
    bucket: "PROMO_OR_EXEMPT" as const,
    period: {
      id: "period-1",
      year: 2026,
      month: 9,
      status: "PROMO" as const,
      planId,
      planName,
      amount: 10,
      currency: "USD" as const,
      method: null,
      notes: null,
      promoName: null,
      promoReason: null,
      promoRecurring: false,
      recordedById: "user-1",
      recordedByEmail: "owner@example.com",
      recordedAt: new Date("2026-09-20T12:00:00Z"),
    },
  };
}

function renderTable(row: ReturnType<typeof promoRowOn>) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentsTable
        organizationId="org-1"
        rows={[row]}
        plans={ACTIVE_PLANS}
        academies={[{ id: "academy-1", name: "Heredia" }]}
        currentYear={2026}
        currentMonth={9}
        canRecordPayments={true}
        locale="en"
      />
    </NextIntlClientProvider>,
  );
}

describe("Pagos edit sheet, for a payment on a plan that has since been deactivated", () => {
  afterEach(() => {
    cleanup();
    recordPaymentMock.mockReset();
  });

  it("REQUIRED: offers the payment's own inactive plan, selected and marked, alongside the active ones", () => {
    renderTable(promoRowOn("plan-dead", "December Promo"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const planSelect = within(screen.getByRole("dialog")).getByLabelText("Plan") as HTMLSelectElement;
    const options = [...planSelect.options].map((o) => o.textContent);
    expect(options).toContain("December Promo (inactive)");
    expect(options).toContain("Monthly");
    expect(planSelect.value).toBe("plan-dead");
  });

  it("REQUIRED: saving the correction submits that same plan — the payment is not silently moved or blanked", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderTable(promoRowOn("plan-dead", "December Promo"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Notes (optional)"), { target: { value: "corrected" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submitted = recordPaymentMock.mock.calls[0][2] as FormData;
    expect(submitted.get("planId")).toBe("plan-dead");
    expect(submitted.get("notes")).toBe("corrected");
    expect(submitted.get("year")).toBe("2026");
    expect(submitted.get("month")).toBe("9");
  });

  it("does not add a duplicate, marked entry when the payment's plan is still active", () => {
    renderTable(promoRowOn("plan-monthly", "Monthly"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const planSelect = within(screen.getByRole("dialog")).getByLabelText("Plan") as HTMLSelectElement;
    const options = [...planSelect.options].map((o) => o.textContent);
    expect(options.filter((o) => o?.includes("Monthly"))).toEqual(["Monthly"]);
    expect(planSelect.value).toBe("plan-monthly");
  });
});
