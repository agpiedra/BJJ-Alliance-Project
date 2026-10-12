/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Component-level coverage for the Escape-during-pending dismissal bug in DangerZone's
 * AlertDialog-based Suspend/Cancel confirmations (PR #113 follow-up), using the exact
 * established convention `tests/unit/exchange-rate-forms.test.tsx` uses (`@vitest-environment
 * jsdom`, `@testing-library/react`, `vi.mock()` of the action module, `NextIntlClientProvider`).
 * Both actions are mocked with a DEFERRED promise this file resolves by hand, so the pending
 * window itself can be asserted on before resolution -- none of this hits a real database or a
 * real server action.
 */

const suspendOrganizationAction = vi.fn();
const reactivateOrganizationAction = vi.fn();
const cancelOrganizationAction = vi.fn();
vi.mock("../../src/app/[locale]/platform/organizations/actions", () => ({
  suspendOrganizationAction: (...args: unknown[]) => suspendOrganizationAction(...args),
  reactivateOrganizationAction: (...args: unknown[]) => reactivateOrganizationAction(...args),
  cancelOrganizationAction: (...args: unknown[]) => cancelOrganizationAction(...args),
}));

const { DangerZone } = await import("../../src/app/[locale]/platform/organizations/[id]/danger-zone");

function withMessages(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

/** A promise this file controls the resolution of, so "pending" can be asserted precisely. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  suspendOrganizationAction.mockReset();
  reactivateOrganizationAction.mockReset();
  cancelOrganizationAction.mockReset();
});

describe("DangerZone: cancel dialog pending-dismissal guard", () => {
  it("REQUIRED: Escape while the cancellation request is pending leaves the dialog open and the note intact", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    cancelOrganizationAction.mockReturnValue(promise);

    render(withMessages(<DangerZone organizationId="org-1" status="ACTIVE" />));
    fireEvent.click(screen.getByRole("button", { name: "Cancel organization" }));

    const noteInput = await screen.findByRole("textbox");
    fireEvent.change(noteInput, { target: { value: "Non-paying for 6 months" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    // Pending: the confirm button is disabled while the request is in flight.
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm cancellation" })).toBeDisabled());

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    // Still open, note still there -- the bug this test guards against cleared both on Escape.
    expect(screen.getByRole("textbox")).toHaveValue("Non-paying for 6 months");
    expect(screen.getByText("This permanently cancels the organization. Continue?")).toBeInTheDocument();

    resolve({}); // drain the pending promise so the test doesn't leak a floating transition
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("REQUIRED: resolving with a server error keeps the note and shows the visible error", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    cancelOrganizationAction.mockReturnValue(promise);

    render(withMessages(<DangerZone organizationId="org-1" status="ACTIVE" />));
    fireEvent.click(screen.getByRole("button", { name: "Cancel organization" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Dispute with owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    resolve({ error: "noteRequired" });

    await screen.findByText("A reason is required to cancel.");
    expect(screen.getByRole("textbox")).toHaveValue("Dispute with owner");
    // The error is associated with the input for a screen-reader user, not just visible text.
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-describedby", "danger-zone-cancel-error");
  });

  it("REQUIRED: a successful cancellation closes the dialog", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    cancelOrganizationAction.mockReturnValue(promise);

    render(withMessages(<DangerZone organizationId="org-1" status="ACTIVE" />));
    fireEvent.click(screen.getByRole("button", { name: "Cancel organization" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Closed by owner request" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    resolve({});

    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(cancelOrganizationAction).toHaveBeenCalledWith("org-1", "Closed by owner request");
  });
});

describe("DangerZone: suspend dialog pending-dismissal guard and duplicate-submit prevention", () => {
  it("REQUIRED: Escape while the suspend request is pending does not close the dialog", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    suspendOrganizationAction.mockReturnValue(promise);

    render(withMessages(<DangerZone organizationId="org-1" status="ACTIVE" />));
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));

    const confirmButtons = () => screen.getAllByRole("button", { name: "Suspend" });
    // Two "Suspend" buttons exist once the dialog is open: the trigger (now hidden behind the
    // dialog but still in the DOM) and the dialog's own destructive confirm button -- take the last.
    fireEvent.click(confirmButtons()[confirmButtons().length - 1]);

    await waitFor(() => expect(confirmButtons()[confirmButtons().length - 1]).toBeDisabled());

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    expect(screen.getByText("Suspend this organization? Its members will lose access on their next request.")).toBeInTheDocument();

    resolve({});
    await waitFor(() =>
      expect(screen.queryByText("Suspend this organization? Its members will lose access on their next request.")).not.toBeInTheDocument(),
    );
  });

  it("REQUIRED: clicking the destructive confirm button again while pending does not submit a second time", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    suspendOrganizationAction.mockReturnValue(promise);

    render(withMessages(<DangerZone organizationId="org-1" status="ACTIVE" />));
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const confirmButtons = () => screen.getAllByRole("button", { name: "Suspend" });
    const confirmButton = confirmButtons()[confirmButtons().length - 1];

    fireEvent.click(confirmButton);
    await waitFor(() => expect(confirmButton).toBeDisabled());

    // A disabled button does not dispatch click handlers in the real DOM (jsdom included) --
    // this is the mechanism that must actually prevent the second submit, not an assumption.
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    resolve({});
    await waitFor(() => expect(suspendOrganizationAction).toHaveBeenCalledTimes(1));
  });
});
