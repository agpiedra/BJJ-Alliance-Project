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
    getCurrentExchangeRate.mockResolvedValue(ROW_1); // a row IS found for this date — add.stale (not add.staleNotFound) is the correct message
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

describe("AddExchangeRateForm: a stale refusal for a date outside the listed window still produces a working correction (bug fix)", () => {
  it("fetches the current row for the EXACT submitted date (not today's default) and renders a fully working embedded Correct form, never a dead-end message alone", async () => {
    const OUTSIDE_WINDOW_ROW = { id: "q-outside", quoteDate: { year: 2025, month: 6, day: 1 }, revision: 1, value: "450.00" };
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate.mockResolvedValueOnce({ error: "stale" }).mockResolvedValueOnce({ ok: true });
    getCurrentExchangeRate.mockResolvedValue(OUTSIDE_WINDOW_ROW);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.change(screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.year), { target: { value: "2025" } });
    fireEvent.change(screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.month), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.day), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value), { target: { value: "460.00" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));

    // Fetched for the date the owner actually typed, not todayParts()'s default.
    await waitFor(() => expect(getCurrentExchangeRate).toHaveBeenCalledWith("org-1", { year: 2025, month: 6, day: 1 }));
    // A full, working Correct form renders inline — not merely a string pointing at a form that may not exist on the page.
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open)).toBeTruthy());
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    const valueInputs = screen.getAllByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement[];
    const embeddedValueInput = valueInputs[valueInputs.length - 1]; // the Add form's own field is the first match
    expect(embeddedValueInput.value).toBe(OUTSIDE_WINDOW_ROW.value);

    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.success)).toBeTruthy());
  });

  it("a rejected getCurrentExchangeRate fetch shows an explicit failure message, never a silent blank", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockRejectedValue(new Error("network down"));
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.staleLoadFailed)).toBeTruthy());
  });
});

describe("AddExchangeRateForm: three distinct stale-target states — loading, failed, loaded-but-null (bug fix)", () => {
  it("shows a distinct loading message while the lookup is in flight", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    let resolveLookup!: (value: typeof ROW_2 | null) => void;
    const pending = new Promise<typeof ROW_2 | null>((resolve) => {
      resolveLookup = resolve;
    });
    getCurrentExchangeRate.mockReturnValue(pending);
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.staleLoading)).toBeTruthy());
    resolveLookup(null); // avoid a dangling unresolved promise after the test
  });

  it("a rejected lookup shows the failure message and a Retry button, never the generic add.stale text that would promise a form that isn't rendered", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockRejectedValue(new Error("network down"));
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.staleLoadFailed)).toBeTruthy());
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.retry)).toBeTruthy();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.add.stale)).toBeNull();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.correct.open)).toBeNull();
  });

  it("a successful lookup that finds nothing shows its own distinct not-found message plus Retry, never the generic add.stale text (no embedded form actually renders)", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(null);
    render(withMessages(<AddExchangeRateForm organizationId="org-1" />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.add.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.add.staleNotFound)).toBeTruthy());
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.retry)).toBeTruthy();
    // The success-case message promises a form below; it must not appear when no form actually renders.
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.add.stale)).toBeNull();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.correct.open)).toBeNull();
  });
});

describe("CorrectExchangeRateForm: stale-form preservation (mocked \"stale\" response)", () => {
  it("preserves the owner's typed value, never discarding it, after a mocked stale refusal", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    // Deferred, not resolved up front: controls exactly when the refreshed row (ROW_2) arrives, so "the alert
    // banner is showing" and "the q2 refetch has actually happened" can be told apart instead of conflated.
    let resolveRefresh!: (value: typeof ROW_2) => void;
    const refreshPending = new Promise<typeof ROW_2>((resolve) => {
      resolveRefresh = resolve;
    });
    getCurrentExchangeRate.mockReturnValue(refreshPending);
    // Different counts per target id — a single shared count would let a stale q1 read satisfy the same assertion
    // a genuine q2 read would, hiding exactly the race this test exists to catch.
    getExchangeRateCorrectionWarning.mockImplementation((_organizationId: string, forId: string) =>
      Promise.resolve(forId === ROW_2.id ? 3 : 1),
    );

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    const valueInput = screen.getByLabelText(enMessages.payments.plans.exchangeRate.fields.value) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "999.99" } });
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));

    // The refresh is genuinely still in flight: only q1's (the original row's) warning has been requested so far.
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleLoading)).toBeTruthy());
    expect(getExchangeRateCorrectionWarning).toHaveBeenCalledWith("org-1", ROW_1.id);
    expect(getExchangeRateCorrectionWarning).not.toHaveBeenCalledWith("org-1", ROW_2.id);

    resolveRefresh(ROW_2);

    // The refreshed current-value banner (fed by the mocked getCurrentExchangeRate) must appear...
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // ...while the owner's own typed value is untouched (useDuesAction only resets on ok: true, never on "stale").
    expect(valueInput.value).toBe("999.99");
    // The warning count shown must match the NEW target (ROW_2's id) — waited for explicitly, not inferred from
    // the alert alone: the alert and the warning refetch are two independent effects that commit on the same
    // render but resolve on separate microtasks, so the refetch can still be pending once the alert is visible.
    await waitFor(() => expect(getExchangeRateCorrectionWarning).toHaveBeenCalledWith("org-1", ROW_2.id));
    // count=3 renders the plural "other" form ("3 settled payments used…"); count=1 (q1's figure) renders "one
    // settled payment used…" — distinct text, so this can only pass once q2's own count is actually displayed.
    await waitFor(() => expect(screen.getByText(/3 settled payments used/)).toBeTruthy());
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

const useRevisionLabel = (revision: number) => enMessages.payments.plans.exchangeRate.correct.useRevision.replace("{revision}", String(revision));

describe("CorrectExchangeRateForm: stale recovery actually lets the owner retry correctly (bug fix)", () => {
  it("resubmitting after explicitly accepting the refreshed revision carries the NEW revision, never the original row's", async () => {
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate.mockResolvedValueOnce({ error: "stale" }).mockResolvedValueOnce({ ok: true });
    getCurrentExchangeRate.mockResolvedValue(ROW_2);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // Never auto-applied: the owner must click an explicit accept control before the hidden field changes.
    const acceptButton = await screen.findByText(useRevisionLabel(ROW_2.revision));
    fireEvent.click(acceptButton);
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));

    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(2));
    const secondCallFormData = enterOrCorrectExchangeRate.mock.calls[1].at(-1) as FormData;
    expect(secondCallFormData.get("expectedCurrentRevision")).toBe(String(ROW_2.revision));
  });

  it("the submit button stays disabled on a stale result until the owner explicitly accepts the refreshed target", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(ROW_2);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const submitButton = screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit).closest("button") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    fireEvent.click(await screen.findByText(useRevisionLabel(ROW_2.revision)));
    expect(submitButton.disabled).toBe(false);
  });

  it("chains through a SECOND concurrent correction: accept 2, resubmit, get stale again (someone else reached 3 meanwhile), see 3, accept 3, resubmit, succeed", async () => {
    const ROW_3 = { id: "q3", quoteDate: ROW_1.quoteDate, revision: 3, value: "515.00" };
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate
      .mockResolvedValueOnce({ error: "stale" })
      .mockResolvedValueOnce({ error: "stale" })
      .mockResolvedValueOnce({ ok: true });
    getCurrentExchangeRate.mockReset();
    getCurrentExchangeRate.mockResolvedValueOnce(ROW_2).mockResolvedValueOnce(ROW_3);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(await screen.findByText(useRevisionLabel(ROW_2.revision)));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));

    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(2));
    expect((enterOrCorrectExchangeRate.mock.calls[1].at(-1) as FormData).get("expectedCurrentRevision")).toBe(String(ROW_2.revision));

    // A second, independent stale result arrives — the banner must update to the NEW current target (revision 3).
    await waitFor(() => expect(screen.getByText(useRevisionLabel(ROW_3.revision))).toBeTruthy());
    fireEvent.click(screen.getByText(useRevisionLabel(ROW_3.revision)));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));

    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(3));
    expect((enterOrCorrectExchangeRate.mock.calls[2].at(-1) as FormData).get("expectedCurrentRevision")).toBe(String(ROW_3.revision));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.success)).toBeTruthy());
  });
});

describe("CorrectExchangeRateForm: submit gating covers loading/failed/loaded-null, not just loaded-with-a-row (bug fix)", () => {
  it("REPRO: while the refresh fetch is still loading, the submit button must stay disabled (it previously was not)", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    let resolveRefresh!: (value: typeof ROW_2 | null) => void;
    const pending = new Promise<typeof ROW_2 | null>((resolve) => {
      resolveRefresh = resolve;
    });
    getCurrentExchangeRate.mockReturnValue(pending);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleLoading)).toBeTruthy());
    const submitButton = screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit).closest("button") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    resolveRefresh(ROW_2); // avoid a dangling unresolved promise after the test
  });

  it("a rejected refresh fetch keeps submit disabled, shows the failure message plus a Retry button, and dispatches no second write even if the disabled button is clicked", async () => {
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate.mockResolvedValueOnce({ error: "stale" });
    getCurrentExchangeRate.mockRejectedValue(new Error("network down"));
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleLoadFailed)).toBeTruthy());
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.retry)).toBeTruthy();
    const submitButton = screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit).closest("button") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    fireEvent.click(submitButton);
    expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(1); // only the original submit — a disabled button dispatches nothing
  });

  it("a refresh that resolves successfully but finds no row keeps submit disabled and shows a message distinct from both the loading and failure messages, plus Retry", async () => {
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate.mockResolvedValueOnce({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(null);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleNotFound)).toBeTruthy());
    expect(screen.getByText(enMessages.payments.plans.exchangeRate.retry)).toBeTruthy();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.correct.staleLoading)).toBeNull();
    expect(screen.queryByText(enMessages.payments.plans.exchangeRate.correct.staleLoadFailed)).toBeNull();
    const submitButton = screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit).closest("button") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });

  it("recovery after Retry: a failed fetch, then Retry resolves with a real row, then accept, then submit succeeds carrying the accepted revision", async () => {
    enterOrCorrectExchangeRate.mockReset();
    enterOrCorrectExchangeRate.mockResolvedValueOnce({ error: "stale" }).mockResolvedValueOnce({ ok: true });
    getCurrentExchangeRate.mockReset();
    getCurrentExchangeRate.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(ROW_2);
    getExchangeRateCorrectionWarning.mockResolvedValue(0);

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleLoadFailed)).toBeTruthy());

    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.retry));
    const acceptButton = await screen.findByText(useRevisionLabel(ROW_2.revision));
    fireEvent.click(acceptButton);

    const submitButton = screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit).closest("button") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    fireEvent.click(submitButton);

    await waitFor(() => expect(enterOrCorrectExchangeRate).toHaveBeenCalledTimes(2));
    expect((enterOrCorrectExchangeRate.mock.calls[1].at(-1) as FormData).get("expectedCurrentRevision")).toBe(String(ROW_2.revision));
  });
});

describe("CorrectExchangeRateForm: warning count race between two targets (bug fix)", () => {
  it("a late-arriving response for the ORIGINAL (no-longer-current) target never overwrites the count already shown for the refreshed target", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getCurrentExchangeRate.mockResolvedValue(ROW_2);

    let resolveOriginal!: (value: number) => void;
    let resolveRefreshed!: (value: number) => void;
    const originalPromise = new Promise<number>((resolve) => {
      resolveOriginal = resolve;
    });
    const refreshedPromise = new Promise<number>((resolve) => {
      resolveRefreshed = resolve;
    });
    getExchangeRateCorrectionWarning.mockImplementation((_orgId: string, quoteId: string) => (quoteId === ROW_1.id ? originalPromise : refreshedPromise));

    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(getExchangeRateCorrectionWarning).toHaveBeenCalledWith("org-1", ROW_2.id));

    // Resolve the NEWER (currently-displayed) target's fetch first...
    resolveRefreshed(7);
    await waitFor(() => expect(screen.getByText(/7/)).toBeTruthy());
    // ...then the SLOWER, now-superseded original target's fetch resolves AFTER — it must be discarded, not applied.
    resolveOriginal(99);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/99/)).toBeNull();
    expect(screen.getByText(/7/)).toBeTruthy();
  });
});

describe("CorrectExchangeRateForm: explicit failure states for the warning/refresh reads (bug fix)", () => {
  it("a rejected warning-count fetch shows an explicit failure message, never rendered as zero or blank", async () => {
    getExchangeRateCorrectionWarning.mockRejectedValue(new Error("network down"));
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.warningLoadFailed)).toBeTruthy());
  });

  it("a rejected stale-refresh fetch shows an explicit failure message, never silently blank", async () => {
    enterOrCorrectExchangeRate.mockResolvedValue({ error: "stale" });
    getExchangeRateCorrectionWarning.mockResolvedValue(0);
    getCurrentExchangeRate.mockRejectedValue(new Error("network down"));
    render(withMessages(<CorrectExchangeRateForm organizationId="org-1" row={ROW_1} />));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.open));
    fireEvent.click(screen.getByText(enMessages.payments.plans.exchangeRate.correct.submit));
    await waitFor(() => expect(screen.getByText(enMessages.payments.plans.exchangeRate.correct.staleLoadFailed)).toBeTruthy());
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
