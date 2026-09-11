/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Regression test for Phase 6 Task 2 fix round 1: leaving the "Amount" or
 * "Notes" field blank on the record-payment form used to submit
 * `amount=""` / `notes=""` — a genuinely PRESENT, empty-string FormData
 * entry, not an ABSENT one. Task 1's zod schema
 * (`z.coerce.number().min(0).optional()`) coerces `""` to `0`
 * (`Number("") === 0`), so a blank amount silently recorded a real $0
 * payment rather than leaving it unspecified, and blank notes stored `""`
 * instead of `null` (breaking the `?? "—"` fallback used everywhere else in
 * this UI).
 *
 * The fix lives in the form's submit handler, not the schema: strip
 * empty-string `amount`/`notes` from the `FormData` before it ever reaches
 * `recordPayment`, so the field is genuinely absent (`FormData.has(...) ===
 * false`) rather than present-but-empty. This test renders the real,
 * production `RecordPaymentForm` component (not a reimplementation) and
 * asserts on the actual `FormData` object the mocked server action
 * receives — the only way to prove the stripping happens client-side,
 * before `recordPayment`'s zod schema (deliberately unmodified and out of
 * scope for this fix) ever sees the request.
 */
vi.mock("@/app/[locale]/(staff)/students/[id]/payment-actions", () => ({
  recordPayment: vi.fn(),
}));

const { recordPayment } = await import("@/app/[locale]/(staff)/students/[id]/payment-actions");
const { RecordPaymentForm } = await import("@/app/[locale]/(staff)/students/[id]/record-payment-form");

const recordPaymentMock = vi.mocked(recordPayment);

function renderForm() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RecordPaymentForm
        studentId="student-1"
        plans={[{ id: "plan-1", name: "Mensualidad" }]}
        defaultYear={2026}
        defaultMonth={3}
      />
    </NextIntlClientProvider>,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "plan-1" } });
}

describe("RecordPaymentForm", () => {
  afterEach(() => {
    cleanup();
    recordPaymentMock.mockReset();
  });

  it("omits `amount` and `notes` entirely from the submitted FormData when both are left blank", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submittedFormData = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submittedFormData.has("amount")).toBe(false);
    expect(submittedFormData.has("notes")).toBe(false);
  });

  it("omits only the blank field when notes is filled in but amount is left blank", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "cash" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submittedFormData = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submittedFormData.has("amount")).toBe(false);
    expect(submittedFormData.get("notes")).toBe("cash");
  });

  it("submits a real amount unchanged — no regression to the happy path", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Amount (optional)"), { target: { value: "45000" } });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "cash" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submittedFormData = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submittedFormData.get("amount")).toBe("45000");
    expect(submittedFormData.get("notes")).toBe("cash");
  });

  it("strips a whitespace-only amount too, not just a strictly empty string", async () => {
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "   " } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submittedFormData = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submittedFormData.has("notes")).toBe(false);
  });

  it("does NOT strip a literal \"0\" typed into Amount — only genuinely blank input counts as unspecified", async () => {
    // Regression pin for Phase 6 Task 2's fix round (M-6 from the final
    // whole-branch review): the stripping logic keys off `value.trim() ===
    // ""`, so a director deliberately typing "0" (a real, intentional
    // zero-dollar amount — distinct from leaving the field blank) must
    // survive into the submitted FormData unchanged, not be treated as
    // "unspecified" and stripped. This was manually verified at the time of
    // the original fix but never pinned by a committed test until now.
    recordPaymentMock.mockResolvedValue({ ok: true });
    renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Amount (optional)"), { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(recordPaymentMock).toHaveBeenCalledTimes(1));
    const submittedFormData = recordPaymentMock.mock.calls[0][1] as FormData;
    expect(submittedFormData.has("amount")).toBe(true);
    expect(submittedFormData.get("amount")).toBe("0");
  });
});
