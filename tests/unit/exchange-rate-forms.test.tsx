/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Owner exchange-rate UI brief §5.3: component-level behavior under each `ActionState` shape, following the exact
 * established convention `tests/unit/create-student-form.test.tsx` already uses (`@vitest-environment jsdom`,
 * `@testing-library/react`, `vi.mock()` of the action module, `NextIntlClientProvider`). Every case below uses a
 * `vi.fn()`-mocked action/import — none hits a real database or a real `enterExchangeRateQuote` call; that is
 * deliberate and stated here explicitly, matching the brief's own "state clearly which responses are mocked"
 * requirement. `ExchangeRateSection` is an async server component: rendered here via `render(await
 * ExchangeRateSection(props))`, the standard way to unit-test a resolved RSC tree with RTL — once awaited it is a
 * plain React element tree, and the client components inside it (`AddExchangeRateForm`/`CorrectExchangeRateForm`)
 * render normally under jsdom regardless of the server/client distinction, which is a Next.js bundling concept with
 * no equivalent at test time.
 */

const enterOrCorrectExchangeRate = vi.fn();
const getExchangeRateCorrectionWarning = vi.fn();
const getCurrentExchangeRate = vi.fn();
vi.mock("../../src/lib/dues/exchange-rate-actions", () => ({
  enterOrCorrectExchangeRate,
  getExchangeRateCorrectionWarning,
  getCurrentExchangeRate,
}));

const isActive = vi.fn();
vi.mock("../../src/lib/dues/ledger/activation", () => ({
  inactiveLedgerActivation: { isActive: (...args: unknown[]) => isActive(...args) },
}));

const listRecentExchangeRateQuotes = vi.fn();
vi.mock("../../src/lib/dues/exchange-rate-queries", () => ({ listRecentExchangeRateQuotes }));

// next-intl/server's getTranslations refuses to run once it detects a client (jsdom) environment — real in
// production (an RSC never renders under jsdom), but it means ExchangeRateSection (an async server component)
// cannot call the real one here. Mocked with a minimal dotted-path lookup into the SAME real en.json this file
// already uses for its client-side NextIntlClientProvider assertions, so both sides read identical strings.
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a plain recursive message-tree walk
    const root = namespace.split(".").reduce((node: any, segment) => node[segment], enMessages as any);
    return (key: string) => key.split(".").reduce((node: any, segment) => node[segment], root); // eslint-disable-line @typescript-eslint/no-explicit-any
  },
}));

// dues-config-forms.tsx (reused here for useDuesAction/TextField/Outcome/Disclosure) imports config-actions.ts at
// module scope, which eagerly imports `prisma` — unrelated to this feature and unavailable (no DATABASE_URL) in a
// unit test. Mocked purely to short-circuit that transitive import; none of these five are ever called here.
vi.mock("../../src/lib/dues/config-actions", () => ({
  addPlanTerms: vi.fn(),
  addPolicyVersion: vi.fn(),
  correctPlanTerms: vi.fn(),
  correctPolicyVersion: vi.fn(),
  createPackagePlan: vi.fn(),
}));

const { AddExchangeRateForm, CorrectExchangeRateForm } = await import("../../src/app/[locale]/(staff)/payments/plans/exchange-rate-forms");
const { ExchangeRateSection } = await import("../../src/app/[locale]/(staff)/payments/plans/exchange-rate-section");

function withMessages(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

const ROW_1 = { id: "q1", quoteDate: { year: 2031, month: 3, day: 15 }, revision: 1, value: "505.37" };
const ROW_2 = { id: "q2", quoteDate: { year: 2031, month: 3, day: 15 }, revision: 2, value: "510.00" };

beforeEach(() => {
  enterOrCorrectExchangeRate.mockReset();
  getExchangeRateCorrectionWarning.mockReset().mockResolvedValue(0);
  getCurrentExchangeRate.mockReset();
  isActive.mockReset();
  listRecentExchangeRateQuotes.mockReset().mockResolvedValue([]);
});

describe("ExchangeRateSection: inactive pre-check rendering (mocked isActive)", () => {
  it("renders the explanatory unavailable text and no form when isActive resolves false", async () => {
    isActive.mockResolvedValue(false);
    render(withMessages(await ExchangeRateSection({ organizationId: "org-1" })));
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.inactive)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.add.open)).toBeNull();
  });

  it("renders the Add form and an empty-list message when isActive resolves true with no quotes", async () => {
    isActive.mockResolvedValue(true);
    listRecentExchangeRateQuotes.mockResolvedValue([]);
    render(withMessages(await ExchangeRateSection({ organizationId: "org-1" })));
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.open)).toBeTruthy();
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.none)).toBeTruthy();
  });

  it("renders a Correct form per listed quote when isActive resolves true with quotes", async () => {
    isActive.mockResolvedValue(true);
    listRecentExchangeRateQuotes.mockResolvedValue([ROW_1]);
    render(withMessages(await ExchangeRateSection({ organizationId: "org-1" })));
    expect(screen.getAllByText(enMessages.payments.plans.exchangeRate.correct.open)).toHaveLength(1);
  });
});

describe("AddExchangeRateForm: submits via enterOrCorrectExchangeRate (mocked), resets only on success", () => {
  it("a successful submission (mocked ok: true) resets the form", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ ok: true });
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    const valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "505.37" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.success)).toBeTruthy());
    expect(valueInput.value).toBe("");
  });

  it("a mocked stale refusal shows the add.stale message and preserves the owner's typed value (bug fix: this previously rendered nothing at all)", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    const valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "505.37" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.stale)).toBeTruthy());
    expect(valueInput.value).toBe("505.37"); // not reset — useDuesAction only resets on ok: true
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.add.success)).toBeNull();
  });
});

describe("CorrectExchangeRateForm: stale-form preservation (mocked \"stale\" response)", () => {
  it("preserves the owner's typed value, never discarding it, after a mocked stale refusal", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(ROW_2);
    getExchangeRateCorrectionWarning.mockResolvedValue(3);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    const valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "999.99" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));

    // The refreshed current-value banner (fed by the mocked getCurrentExchangeRate) must appear...
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // ...while the owner's own typed value is untouched (useDuesAction only resets on ok: true, never on "stale").
    expect(valueInput.value).toBe("999.99");
    // The warning count shown must match the NEW target (ROW_2's id), fetched a second time after the refresh.
    expect(getExchangeRateCorrectionWarning).toHaveBeenCalledWith("org-1", ROW_2.id);
    await waitFor(() => expect(screen.getByText(/3/)).toBeTruthy());
  });

  it("never calls getCurrentExchangeRate (the refresh read) when the result is not stale", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "invalid" });
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalled());
    expect(getCurrentExchangeRate).not.toHaveBeenCalled();
  });
});

describe("CorrectExchangeRateForm: remount-on-success only (key={row.revision})", () => {
  it("a parent re-render with a NEW row (simulating a successful correction's revalidated data) resets to the new row's own defaults", async () => {
    const { rerender } = render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    let valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    expect(valueInput.value).toBe(ROW_1.value);
    fireEvent.change(valueInput, { target: { value: "999.99" } });
    expect(valueInput.value).toBe("999.99");

    // Parent re-renders with the NEW current row (as it would after revalidatePath following a real success) — the
    // Disclosure's key={row.revision} changes from 1 to 2, remounting the subtree with ROW_2's own defaults.
    rerender(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_2} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    expect(valueInput.value).toBe(ROW_2.value); // reset to the new row's default, not "999.99"
  });

  it("does NOT remount when a \"stale\" result arrives under an UNCHANGED row prop", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(ROW_2);
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    const valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "999.99" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // Still the same DOM node, still the owner's typed value — row prop never changed, so the key never changed.
    expect(valueInput.value).toBe("999.99");
  });
});

describe("CorrectExchangeRateForm: warning count (mocked)", () => {
  it("fetches and displays the count for this row's own id on mount", async () => {
    getExchangeRateCorrectionWarning.mockResolvedValue(5);
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    expect(getExchangeRateCorrectionWarning).toHaveBeenCalledWith("org-1", ROW_1.id);
    await waitFor(() => expect(screen.getByText(/5/)).toBeTruthy());
  });

  it("shows nothing when the count is zero", async () => {
    getExchangeRateCorrectionWarning.mockResolvedValue(0);
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    await waitFor(() => expect(getExchangeRateCorrectionWarning).toHaveBeenCalled());
    expect(screen.queryByText(/settled payment/)).toBeNull();
  });
});

describe("Outcome rendering for invalid/notFound (mocked)", () => {
  it("renders the invalid message", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "invalid" });
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.dues.error.invalid)).toBeTruthy());
  });

  it("renders the notFound message", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "notFound" });
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.dues.error.notFound)).toBeTruthy());
  });
});
