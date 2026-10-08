/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §6: the portal's own history section, reusing
 * `[id]/payment-history-section.test.tsx`'s own proven props-reconciliation + stale-response-discard pattern.
 * Mocks ONLY `getOwnPaymentHistoryPage` (the server action); everything else is the real component. No `notes`
 * field appears anywhere in `PortalPaymentHistoryRow` — structurally impossible to leak here, unlike the staff
 * version.
 */
const getOwnPaymentHistoryPage = vi.fn();
vi.mock("../../src/app/[locale]/portal/payment-history-actions", () => ({ getOwnPaymentHistoryPage }));

const { PortalPaymentHistorySection } = await import("../../src/app/[locale]/portal/payment-history-section");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ROW_1 = {
  id: "pay-1",
  receivedOn: { year: 2030, month: 1, day: 15 },
  tenderCurrency: "USD" as const,
  tenderAmount: "100.00",
  method: "EFECTIVO" as const,
  reversedAt: null,
  conversion: null,
  settlements: [],
};
const ROW_3 = { ...ROW_1, id: "pay-3", tenderAmount: "300.00", receivedOn: { year: 2030, month: 3, day: 15 } };
// Unmistakably distinct from every other fixture row's own amount/date — the stale row must be identifiable on
// its OWN content, never by coincidence with another row.
const STALE_ROW = { ...ROW_1, id: "pay-stale", tenderAmount: "275.00", receivedOn: { year: 2030, month: 5, day: 5 } };

function sectionElement(props: Partial<React.ComponentProps<typeof PortalPaymentHistorySection>> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalPaymentHistorySection
        organizationId="org-1"
        initialRows={[ROW_1]}
        initialCursor="cursor-1"
        initialFailed={false}
        locale="en"
        {...props}
      />
    </NextIntlClientProvider>
  );
}
function renderSection(props: Partial<React.ComponentProps<typeof PortalPaymentHistorySection>> = {}) {
  return render(sectionElement(props));
}

describe("PortalPaymentHistorySection: load-more behavior", () => {
  it("preserves already-loaded rows and shows a dedicated retry when load-more fails, never clearing the list", async () => {
    getOwnPaymentHistoryPage.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    renderSection();

    expect(screen.getByText("$ 100.00")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    expect(screen.getByText("$ 100.00")).toBeTruthy();
  });

  it("a second click while the first request is still in flight never fires a duplicate request (the button disables itself)", async () => {
    const first = deferred<{ ok: true; rows: typeof ROW_1[]; nextCursor: string | null }>();
    getOwnPaymentHistoryPage.mockReturnValueOnce(first.promise);
    renderSection();

    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());
    fireEvent.click(screen.getByText("Loading…"));
    expect(getOwnPaymentHistoryPage).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true, rows: [{ ...ROW_1, id: "pay-2" }], nextCursor: null });
    await waitFor(() => expect(screen.getAllByText("$ 100.00").length).toBe(2));
    expect(getOwnPaymentHistoryPage).toHaveBeenCalledTimes(1);
  });
});

describe("PortalPaymentHistorySection: initial-failure recovery (review fix — brief §6)", () => {
  it("failure -> explicit retry -> success shows the real rows, never leaves a failed read looking like empty history", async () => {
    renderSection({ initialRows: [], initialCursor: null, initialFailed: true });
    expect(screen.getByText("Couldn't load ledger payment history.")).toBeTruthy();
    expect(screen.queryByText("No ledger payments yet.")).toBeNull(); // never the EMPTY state for a FAILED read

    getOwnPaymentHistoryPage.mockResolvedValueOnce({ ok: true, rows: [ROW_1], nextCursor: null });
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getByText("$ 100.00")).toBeTruthy());
    expect(screen.queryByText("Couldn't load ledger payment history.")).toBeNull();
    expect(getOwnPaymentHistoryPage).toHaveBeenCalledWith("org-1", undefined); // the same first-page (no cursor) read the server component itself performs
  });

  it("repeated failure: a retry that fails again still shows the unavailable state with its own retry control, never a false empty state", async () => {
    renderSection({ initialRows: [], initialCursor: null, initialFailed: true });

    getOwnPaymentHistoryPage.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(getOwnPaymentHistoryPage).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Couldn't load ledger payment history.")).toBeTruthy();
    expect(screen.queryByText("No ledger payments yet.")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy(); // still retryable, not a dead end

    // And retrying again after the SECOND failure still works.
    getOwnPaymentHistoryPage.mockResolvedValueOnce({ ok: true, rows: [ROW_1], nextCursor: null });
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("$ 100.00")).toBeTruthy());
  });

  it("a second click on Retry while the first retry is still in flight never fires a duplicate request", async () => {
    const first = deferred<{ ok: true; rows: typeof ROW_1[]; nextCursor: string | null }>();
    getOwnPaymentHistoryPage.mockReturnValueOnce(first.promise);
    renderSection({ initialRows: [], initialCursor: null, initialFailed: true });

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());
    fireEvent.click(screen.getByText("Loading…")); // the button is now disabled; this must be a no-op
    expect(getOwnPaymentHistoryPage).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true, rows: [ROW_1], nextCursor: null });
    await waitFor(() => expect(screen.getByText("$ 100.00")).toBeTruthy());
    expect(getOwnPaymentHistoryPage).toHaveBeenCalledTimes(1);
  });

  it("a stale retry response is discarded if refreshed props (a fresh server re-render) arrive first — mutation-verified below", async () => {
    const stale = deferred<{ ok: true; rows: typeof ROW_1[]; nextCursor: string | null }>();
    getOwnPaymentHistoryPage.mockReturnValueOnce(stale.promise);
    const { rerender } = renderSection({ initialRows: [], initialCursor: null, initialFailed: true });

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());

    // The server re-rendered with a fresh, SUCCESSFUL snapshot while the stale retry is still in flight.
    rerender(sectionElement({ initialRows: [ROW_3], initialCursor: null, initialFailed: false }));
    expect(screen.getByText("$ 300.00")).toBeTruthy();
    expect(screen.queryByText("Couldn't load ledger payment history.")).toBeNull();

    // The stale retry finally resolves with its own distinctly-identifiable row — must never override the
    // now-superseded (and already-successful) snapshot.
    stale.resolve({ ok: true, rows: [STALE_ROW], nextCursor: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("$ 300.00")).toBeTruthy();
    expect(screen.queryByText("$ 275.00")).toBeNull();
  });
});

describe("PortalPaymentHistorySection: props reconciliation (mutation-verified deferred-response regression)", () => {
  it("a pending old load-more request cannot append after refreshed initial data replaces it", async () => {
    const stale = deferred<{ ok: true; rows: typeof STALE_ROW[]; nextCursor: string | null }>();
    getOwnPaymentHistoryPage.mockReturnValueOnce(stale.promise);
    const { rerender } = renderSection({ initialRows: [ROW_1], initialCursor: "cursor-1" });

    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());

    // The server re-rendered with a fresh snapshot (same student) WHILE the stale "load more" is still in flight.
    rerender(sectionElement({ initialRows: [ROW_3], initialCursor: null }));
    expect(screen.getByText("$ 300.00")).toBeTruthy();
    expect(screen.queryByText("$ 100.00")).toBeNull();
    expect(screen.queryByText("Load more")).toBeNull();

    // The stale request finally resolves — its own distinctly-identifiable row must never append onto the
    // now-superseded snapshot.
    stale.resolve({ ok: true, rows: [STALE_ROW], nextCursor: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("$ 300.00")).toBeTruthy();
    expect(screen.queryByText("$ 275.00")).toBeNull();
    expect(screen.queryByText("2030-05-05")).toBeNull();
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("an initial failure followed by successful refreshed props shows the rows, not a stale empty/failed state", () => {
    const { rerender } = renderSection({ initialRows: [], initialCursor: null, initialFailed: true });
    expect(screen.getByText("Couldn't load ledger payment history.")).toBeTruthy();

    rerender(sectionElement({ initialRows: [ROW_1], initialCursor: null, initialFailed: false }));

    expect(screen.queryByText("Couldn't load ledger payment history.")).toBeNull();
    expect(screen.getByText("$ 100.00")).toBeTruthy();
  });
});

describe("PortalPaymentHistorySection: fixture shape documentation", () => {
  it("this file's own ROW_1 fixture carries no notes key — NOT a proof that the real system can't leak notes", () => {
    // Review fix: this only checks a fixture this file itself wrote — it proves nothing about `PortalPaymentHistoryRow`'s
    // real TypeScript contract (erased at runtime; a row WITH an extra `notes` property would still satisfy it
    // structurally) and nothing about whether the component would render a `notes` field if one were present on a
    // real row. The actual boundary proof — real backend rows, the real projection function, the real component's
    // real props inspected directly, with a mutation check — lives in
    // `tests/integration/portal-page-ledger-render.test.tsx`'s two dedicated boundary tests. This assertion is
    // only a documentation note about this file's own fixtures.
    expect("notes" in ROW_1).toBe(false);
  });
});
