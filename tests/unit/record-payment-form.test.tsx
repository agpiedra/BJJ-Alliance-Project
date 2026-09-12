/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * REDESIGN_BRIEF.md Phase 6 §6.1 moved `RecordPaymentForm` to
 * `@/components/payments/record-payment-form` so it can be shared between
 * the student-detail page (locked to one student) and the new `/payments`
 * route (a full Alumno picker) — this suite exercises the shared component
 * directly, same "assert on the real submitted FormData" approach the
 * original student-detail-only version used, extended for the two real UI
 * changes this phase made: a single `<input type="month">` (still split
 * into the `year`/`month` fields `recordPayment` has always accepted, so
 * that action's own contract/tests didn't need to change) and the
 * custom-promotion sub-panel's role gate.
 */
vi.mock("@/lib/payments/payment-actions", () => ({
  recordPayment: vi.fn(),
}));

const { recordPayment } = await import("@/lib/payments/payment-actions");
const { RecordPaymentForm } = await import("@/components/payments/record-payment-form");

const recordPaymentMock = vi.mocked(recordPayment);

const PLANS = [
  { id: "plan-1", name: "Mensualidad", academyId: "academy-1" },
  { id: "plan-promo", name: "Promoción personalizada", academyId: "academy-1" },
];

const STUDENTS = [
  { id: "student-1", firstName: "Alexis", lastName: "Piedra", academyId: "academy-1", academyName: "Escazú" },
];

function renderForm(overrides: Partial<React.ComponentProps<typeof RecordPaymentForm>> = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RecordPaymentForm
        students={STUDENTS}
        plans={PLANS}
        lockedStudentId="student-1"
        canManagePromotions={true}
        defaults={{ month: "2026-03" }}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

describe("RecordPaymentForm", () => {
  afterEach(() => {
    cleanup();
    recordPaymentMock.mockReset();
  });

  it("splits the native month input (\"YYYY-MM\") into separate year/month FormData fields", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submitted = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submitted.get("year")).toBe("2026");
    expect(submitted.get("month")).toBe("3");
    expect(submitted.has("period")).toBe(false);
  });

  it("omits `amount` and `notes` entirely from the submitted FormData when both are left blank", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submitted = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submitted.has("amount")).toBe(false);
    expect(submitted.has("notes")).toBe(false);
  });

  it("does NOT strip a literal \"0\" typed into Amount — only genuinely blank input counts as unspecified", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-1" } });
    fireEvent.change(screen.getByLabelText("Amount (₡)"), { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submitted = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submitted.get("amount")).toBe("0");
  });

  it("renders a hidden studentId input and no Alumno picker when lockedStudentId is set", () => {
    renderForm();
    expect(screen.queryByText("Student")).not.toBeInTheDocument();
  });

  it("renders a real Alumno picker when no student is locked (the /payments page usage)", () => {
    renderForm({ lockedStudentId: undefined });
    expect(screen.getByLabelText("Student")).toBeInTheDocument();
  });

  it("shows the custom-promotion sub-panel, with a required promo name field, when the promo plan is selected and canManagePromotions is true", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-promo" } });
    expect(screen.getByLabelText("Promotion name")).toBeInTheDocument();
    expect(screen.getByLabelText("Promotion name")).toBeRequired();
    // The main Amount field is replaced by the sub-panel's own "Agreed
    // amount" field for this plan, not duplicated.
    expect(screen.queryByLabelText("Amount (₡)")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agreed amount (₡)")).toBeInTheDocument();
  });

  it("shows the instructor hint instead of the sub-panel when canManagePromotions is false", () => {
    renderForm({ canManagePromotions: false });
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-promo" } });
    expect(screen.getByText("Ask the director to record the promotion.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Promotion name")).not.toBeInTheDocument();
  });

  it("submits the promoRecurring checkbox as present only when checked", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-promo" } });
    fireEvent.change(screen.getByLabelText("Promotion name"), { target: { value: "Beca competidor" } });
    fireEvent.click(screen.getByLabelText("Repeat this promotion every month until removed"));

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submitted = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submitted.get("promoRecurring")).toBe("on");
    expect(submitted.get("promoName")).toBe("Beca competidor");
  });
});
