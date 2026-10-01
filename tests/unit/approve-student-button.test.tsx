/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Enrollment/resume integration plan §7.6: the plan-selector / "existing assignment reused" / "requires an owner"
 * cases — the real enforcement is server-side in `approveStudentInTx`; these are rendering-only proofs, same
 * @testing-library/react + jsdom setup as create-student-form.test.tsx.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/actions", () => ({
  approveStudent: vi.fn(),
}));

const { ApproveStudentButton } = await import("../../src/app/[locale]/(staff)/students/[id]/approve-student-button");

function renderButton(props: Partial<React.ComponentProps<typeof ApproveStudentButton>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ApproveStudentButton organizationId="org-1" studentId="student-1" {...props} />
    </NextIntlClientProvider>,
  );
}

describe("ApproveStudentButton — enrollment/resume integration plan §7.6", () => {
  it("billing inactive (the default): no plan field, no reused-plan line, no 'requires admin' message", () => {
    renderButton();
    expect(screen.queryByLabelText(/Monthly plan/)).toBeNull();
    expect(screen.queryByText(/Monthly plan:/)).toBeNull();
    expect(screen.queryByText(/requires an owner/i)).toBeNull();
  });

  it("billing active, no existing assignment, ADMIN: a keyboard-accessible plan selector is offered", () => {
    renderButton({ billingActive: true, organizationRole: "ADMIN", plans: [{ id: "plan-1", name: "Monthly USD" }] });
    const select = screen.getByRole("combobox", { name: /Monthly plan/ });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "plan-1"]);
  });

  it("billing active, no existing assignment, DIRECTOR: no selector — only the 'requires an owner' message", () => {
    renderButton({ billingActive: true, organizationRole: "DIRECTOR", plans: [{ id: "plan-1", name: "Monthly USD" }] });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Assigning a new plan at approval requires an owner (ADMIN).")).toBeInTheDocument();
  });

  it("billing active, an existing assignment already resolves: reused and displayed, no selector, DIRECTOR may still approve", () => {
    renderButton({ billingActive: true, existingPlanName: "Monthly USD", organizationRole: "DIRECTOR" });
    expect(screen.getByText("Monthly plan: Monthly USD")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("billing active, an existing assignment is explicitly unassigned (null): shown as 'No plan', no selector", () => {
    renderButton({ billingActive: true, existingPlanName: null, organizationRole: "ADMIN" });
    expect(screen.getByText("Monthly plan: No plan")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
