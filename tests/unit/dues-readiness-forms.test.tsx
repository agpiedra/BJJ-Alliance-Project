/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §4, §7.1): the readiness forms' client behaviour, with the actions mocked.
 * Only an explicit response classifies an outcome; a thrown call is "outcome unknown", locks the scope, keeps the typed values,
 * never resubmits, and unlocks only after the owner says they checked the current data.
 */
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  createOpeningDraft: vi.fn(),
  replaceOpeningDraft: vi.fn(),
  withdrawOpeningDraft: vi.fn(),
  recordOpeningReview: vi.fn(),
  acknowledgePricing: vi.fn(),
}));
vi.mock("@/lib/dues/readiness/opening-actions", () => actions);
const assignment = vi.hoisted(() => ({ assignPlan: vi.fn(), correctAssignment: vi.fn() }));
vi.mock("@/lib/dues/assignment-actions", () => assignment);
vi.mock("@/lib/students/baseline-action", () => ({ runStatusHistoryBaseline: vi.fn() }));

const { classifyResponse } = await import("../../src/app/[locale]/(staff)/payments/readiness/outcome-messages");
const { ReadinessClientRoot, ScopeStatus, REFRESH_TIMEOUT_MS } = await import("../../src/app/[locale]/(staff)/payments/readiness/use-readiness-action");
const { AddDraftForm } = await import("../../src/app/[locale]/(staff)/payments/readiness/draft-forms");
const { OpeningReviewControl } = await import("../../src/app/[locale]/(staff)/payments/readiness/confirmation-forms");
const { AssignPlanForm } = await import("../../src/app/[locale]/(staff)/payments/readiness/before-start-panel");

const MESSAGES = { en: enMessages, es: esMessages } as const;
const out = (locale: "en" | "es") => MESSAGES[locale].payments.readiness.forms.outcome;
const T0 = "2026-10-20T17:00:00.000Z";
const T1 = "2026-10-20T17:00:05.000Z";
const T2 = "2026-10-20T17:00:09.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The add-draft form and its card's status region, as the screen mounts them. */
function draftCard(asOf: string, locale: "en" | "es" = "en") {
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <ReadinessClientRoot asOf={asOf}>
        <ScopeStatus scope="student:s1" place="card" activeTargets={[]} />
        <AddDraftForm organizationId="org-1" studentId="s1" legacyOptions={[]} monthLegend="Month owed" />
      </ReadinessClientRoot>
    </NextIntlClientProvider>
  );
}

function fillDraft(container: HTMLElement, amount = "1234.50") {
  fireEvent.change(container.querySelector("select[name=coverageMonth]")!, { target: { value: "3" } });
  fireEvent.change(container.querySelector("input[name=coverageYear]")!, { target: { value: "2026" } });
  fireEvent.change(container.querySelector("input[name=amount]")!, { target: { value: amount } });
  fireEvent.click(container.querySelector("input[name=currency][value=CRC]")!);
  fireEvent.change(container.querySelector("textarea[name=note]")!, { target: { value: "Unpaid March" } });
}
const form = (container: HTMLElement) => container.querySelector("form")!;
const locked = (container: HTMLElement) => container.querySelector("fieldset")!.disabled;
const typed = (container: HTMLElement) => ({
  amount: (container.querySelector("input[name=amount]") as HTMLInputElement).value,
  note: (container.querySelector("textarea[name=note]") as HTMLTextAreaElement).value,
  currency: (container.querySelector("input[name=currency]:checked") as HTMLInputElement | null)?.value ?? null,
});

beforeEach(() => {
  router.refresh.mockReset();
  for (const fn of [...Object.values(actions), ...Object.values(assignment)]) fn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("classifyResponse: only the response decides", () => {
  it("maps each response kind, and a thrown call is unknown, never rejected or saved", () => {
    expect(classifyResponse({ status: "fulfilled", value: { ok: true } })).toEqual({ kind: "saved", count: undefined });
    expect(classifyResponse({ status: "fulfilled", value: { ok: true, count: 3 } })).toEqual({ kind: "saved", count: 3 });
    expect(classifyResponse({ status: "fulfilled", value: { error: "stale" } })).toEqual({ kind: "rejected", code: "stale", fieldErrors: {} });
    expect(classifyResponse({ status: "fulfilled", value: { error: "invalid", fieldErrors: { amount: ["invalid"] } } })).toEqual({ kind: "rejected", code: "invalid", fieldErrors: { amount: ["invalid"] } });
    expect(classifyResponse({ status: "fulfilled", value: { error: "invalid", fieldErrors: { declaration: ["mismatch"] } } })).toMatchObject({ kind: "rejected", code: "declarationMismatch" });
    expect(classifyResponse({ status: "fulfilled", value: { error: "somethingNew" } })).toMatchObject({ kind: "rejected", code: "unexpected" });
    expect(classifyResponse({ status: "rejected" })).toEqual({ kind: "unknown" });
  });
});

describe("the submission flow", () => {
  it("success: one call, 'Saved.', a refresh, locked until a new snapshot arrives, then unlocked", async () => {
    actions.createOpeningDraft.mockResolvedValue({ ok: true });
    const { container, rerender } = render(draftCard(T0));
    fillDraft(container);
    await act(async () => fireEvent.submit(form(container)));
    expect(actions.createOpeningDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain(out("en").saved);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(locked(container)).toBe(true);
    rerender(draftCard(T1));
    expect(locked(container)).toBe(false);
    expect(typed(container).amount).toBe(""); // reset only after an explicit success
  });

  it("a double submit while pending calls the action once", async () => {
    const pending = deferred<{ ok: true }>();
    actions.createOpeningDraft.mockReturnValue(pending.promise);
    const { container } = render(draftCard(T0));
    fillDraft(container);
    await act(async () => {
      fireEvent.submit(form(container));
      fireEvent.submit(form(container));
    });
    expect(actions.createOpeningDraft).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ok: true }));
  });

  it("a field rejection: message under the field, typed values kept, no refresh, not locked", async () => {
    actions.createOpeningDraft.mockResolvedValue({ error: "invalid", fieldErrors: { amount: ["invalid"] } });
    const { container } = render(draftCard(T0));
    fillDraft(container, "12,34");
    await act(async () => fireEvent.submit(form(container)));
    expect(container.querySelector("input[name=amount]")!.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(enMessages.payments.readiness.forms.field.amount);
    expect(typed(container)).toEqual({ amount: "12,34", note: "Unpaid March", currency: "CRC" });
    expect(router.refresh).not.toHaveBeenCalled();
    expect(locked(container)).toBe(false);
    // Focus goes to the refused field — not to the outcome region (found in the real-browser pass: it used to be stolen).
    await waitFor(() => expect(document.activeElement?.getAttribute("name")).toBe("amount"));
  });

  it("stale: refresh, never a second call, locked until the new snapshot, the typed values not overwritten", async () => {
    actions.createOpeningDraft.mockResolvedValue({ error: "monthHasDraft" });
    const { container, rerender } = render(draftCard(T0));
    fillDraft(container);
    await act(async () => fireEvent.submit(form(container)));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(locked(container)).toBe(true);
    rerender(draftCard(T1));
    expect(locked(container)).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain(out("en").rejected.monthHasDraft);
    expect(typed(container)).toEqual({ amount: "1234.50", note: "Unpaid March", currency: "CRC" });
    expect(actions.createOpeningDraft).toHaveBeenCalledTimes(1);
  });

  for (const locale of ["en", "es"] as const) {
    it(`[${locale}] outcome unknown: locked, no automatic refresh or resend, still unknown after any refresh, unlocked only by "checked"`, async () => {
      actions.createOpeningDraft.mockRejectedValue(new TypeError("Failed to fetch"));
      const { container, rerender } = render(draftCard(T0, locale));
      fillDraft(container);
      await act(async () => fireEvent.submit(form(container)));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(out(locale).unknownTitle);
      expect(document.activeElement).toBe(alert);
      expect(router.refresh).not.toHaveBeenCalled();
      expect(locked(container)).toBe(true);
      expect(screen.queryByRole("button", { name: out(locale).checked })).toBeNull(); // inspection comes before unlocking

      fireEvent.click(within(alert).getByRole("button", { name: out(locale).reload }));
      expect(router.refresh).toHaveBeenCalledTimes(1);
      rerender(draftCard(T1, locale)); // a refreshed snapshot — whatever it contains, it is not this request's result
      expect(screen.getByRole("alert").textContent).toContain(out(locale).stillUnknownTitle);
      expect(locked(container)).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: out(locale).reloadAgain }));
      rerender(draftCard(T2, locale));
      expect(screen.getByRole("alert").textContent).toContain(out(locale).stillUnknownTitle);

      const text = container.textContent ?? "";
      expect(text).not.toContain(out(locale).saved);
      for (const message of Object.values(out(locale).rejected)) expect(text).not.toContain(message);
      expect(typed(container)).toEqual({ amount: "1234.50", note: "Unpaid March", currency: "CRC" });

      fireEvent.click(screen.getByRole("button", { name: out(locale).checked }));
      expect(locked(container)).toBe(false);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(actions.createOpeningDraft).toHaveBeenCalledTimes(1);
      expect(typed(container)).toEqual({ amount: "1234.50", note: "Unpaid March", currency: "CRC" });
    });
  }

  it("a refresh that never arrives says so and offers only a full reload", async () => {
    vi.useFakeTimers();
    actions.createOpeningDraft.mockRejectedValue(new TypeError("Failed to fetch"));
    const { container } = render(draftCard(T0));
    fillDraft(container);
    await act(async () => fireEvent.submit(form(container)));
    fireEvent.click(screen.getByRole("button", { name: out("en").reload }));
    await act(async () => vi.advanceTimersByTime(REFRESH_TIMEOUT_MS + 1));
    expect(screen.getByRole("alert").textContent).toContain(out("en").refreshFailed);
    expect(screen.getByRole("button", { name: out("en").reloadPage })).toBeTruthy();
    expect(screen.queryByRole("button", { name: out("en").checked })).toBeNull();
    expect(locked(container)).toBe(true);
  });
});

describe("form invariants", () => {
  it("a new draft's currency has no default", () => {
    const { container } = render(draftCard(T0));
    expect(container.querySelectorAll("input[name=currency]:checked")).toHaveLength(0);
  });

  function review(binding: string, drafts: string[]) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ReadinessClientRoot asOf={T0}>
          <OpeningReviewControl organizationId="org-1" studentId="s1" studentName="Ana" candidate={{ year: 2026, month: 12, label: "December 2026" }} binding={binding} drafts={drafts} />
        </ReadinessClientRoot>
      </NextIntlClientProvider>
    );
  }

  it("the review's label and declaration follow the drafts shown; the dialog restates them; a new binding closes it", async () => {
    actions.recordOpeningReview.mockResolvedValue({ ok: true });
    const { rerender } = render(review("a".repeat(64), []));
    fireEvent.click(screen.getByRole("button", { name: /no opening debt before December 2026/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("no opening debt before December 2026");
    // An attestation dialog opens on Cancel (Base UI moves initial focus after opening).
    await waitFor(() => expect(document.activeElement?.textContent).toBe(enMessages.payments.readiness.forms.cancel));

    rerender(review("b".repeat(64), ["March 2026 · ₡ 1,500 · Unpaid"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /exactly this item/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("March 2026 · ₡ 1,500 · Unpaid");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: enMessages.payments.readiness.forms.review.submit })));
    const sent = actions.recordOpeningReview.mock.calls[0][2] as FormData;
    expect(Object.fromEntries(sent)).toEqual({ studentId: "s1", candidateYear: "2026", candidateMonth: "12", binding: "b".repeat(64), declaration: "itemsAsShown" });
  });

  it("assignment: no plan is preselected, and an explicit 'No plan' needs its own confirmation before any call", async () => {
    assignment.assignPlan.mockResolvedValue({ ok: true });
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ReadinessClientRoot asOf={T0}>
          <AssignPlanForm organizationId="org-1" studentId="s1" studentName="Ana" plans={[{ id: "p1", label: "Monthly" }]} defaultMonth={{ year: 2026, month: 12 }} monthLegend="From" />
        </ReadinessClientRoot>
      </NextIntlClientProvider>,
    );
    expect(container.querySelectorAll("input[name=planId]:checked")).toHaveLength(0);
    fireEvent.click(container.querySelector('input[name=planId][value=""]')!);
    await act(async () => fireEvent.submit(form(container)));
    expect(assignment.assignPlan).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain(enMessages.payments.readiness.forms.assignment.noPlanCurrent);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: enMessages.payments.readiness.forms.assignment.noPlanSubmit })));
    expect(assignment.assignPlan).toHaveBeenCalledTimes(1);
    expect((assignment.assignPlan.mock.calls[0][2] as FormData).get("planId")).toBe("");
  });
});
