/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §7, "usable pagination beyond page 1" + the user's own explicit
 * dispatch requirement: "load more" preserves loaded rows on failure, offers a dedicated retry, and discards an
 * obsolete (superseded) response — the exact behavior `financial-corrections-section.tsx`'s own established
 * `loadMoreFees` pattern already proves for its sibling cards, reproduced here for the student-detail history
 * section. Mocks ONLY `getPaymentHistoryPage` (the server action); everything else is the real component.
 *
 * Review-fix correction: the "a response that lands after a newer request fired is discarded outright" claim
 * above describes real code (`loadMore`'s own `requestRef.current !== requestId` check), but until this fix round
 * NOTHING in this file actually exercised that branch — the UI's own disabled-button behavior (proven by the
 * third test below) already prevents a SECOND "load more" click from ever firing while the first is in flight, so
 * two genuinely overlapping requests never occurred here. The "props reconciliation" describe block below is what
 * first exercises obsolete-response discard for real, via the OTHER way `requestRef` advances: a parent re-render
 * handing this component refreshed server props while a request is still in flight.
 */
const getPaymentHistoryPage = vi.fn();
vi.mock("../../src/app/[locale]/(staff)/students/[id]/payment-history-actions", () => ({ getPaymentHistoryPage }));

const { PaymentHistorySection } = await import("../../src/app/[locale]/(staff)/students/[id]/payment-history-section");

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
  notes: null,
  reversedAt: null,
  conversion: null,
  settlements: [],
};
const ROW_2 = { ...ROW_1, id: "pay-2", receivedOn: { year: 2030, month: 2, day: 15 } };
const ROW_3 = { ...ROW_1, id: "pay-3", tenderAmount: "300.00", receivedOn: { year: 2030, month: 3, day: 15 } };
// Unmistakably distinct from every other fixture row's own amount/date (never "100.00"/"200.00"/"300.00" and never
// Jan/Feb/Mar 2030) — review fix: the stale row must be identifiable on its OWN content, not by a string ("$
// 200.00") that no fixture row actually contains, which would pass vacuously regardless of whether the guard works.
const STALE_ROW = { ...ROW_1, id: "pay-stale", tenderAmount: "275.00", receivedOn: { year: 2030, month: 5, day: 5 } };

function sectionElement(props: Partial<React.ComponentProps<typeof PaymentHistorySection>> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentHistorySection
        organizationId="org-1"
        studentId="student-1"
        initialRows={[ROW_1]}
        initialCursor="cursor-1"
        initialFailed={false}
        locale="en"
        {...props}
      />
    </NextIntlClientProvider>
  );
}

function renderSection(props: Partial<React.ComponentProps<typeof PaymentHistorySection>> = {}) {
  return render(sectionElement(props));
}

describe("PaymentHistorySection: load-more behavior", () => {
  it("preserves already-loaded rows and shows a dedicated retry when load-more fails, never clearing the list", async () => {
    getPaymentHistoryPage.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    renderSection();

    expect(screen.getByText("$ 100.00")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    // The original row is still there — a failed load-more never clears what's already loaded.
    expect(screen.getByText("$ 100.00")).toBeTruthy();
  });

  it("retrying after a failure succeeds and appends the new rows without duplicating the first page", async () => {
    getPaymentHistoryPage.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    renderSection();
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());

    getPaymentHistoryPage.mockResolvedValueOnce({ ok: true, rows: [ROW_2], nextCursor: null });
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getAllByText("$ 100.00").length).toBe(2)); // both rows now rendered
    expect(screen.queryByText("Load more")).toBeNull(); // nextCursor is now null — exhausted
  });

  it("a second click while the first request is still in flight never fires a duplicate request (the button disables itself)", async () => {
    const first = deferred<{ ok: true; rows: typeof ROW_2[]; nextCursor: string | null }>();
    getPaymentHistoryPage.mockReturnValueOnce(first.promise);
    renderSection();

    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());
    fireEvent.click(screen.getByText("Loading…")); // the button is now disabled; this must be a no-op
    expect(getPaymentHistoryPage).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true, rows: [ROW_2], nextCursor: null });
    await waitFor(() => expect(screen.getAllByText("$ 100.00").length).toBe(2));
    // Still exactly one call — the disabled second click never reached `getPaymentHistoryPage` at all.
    expect(getPaymentHistoryPage).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentHistorySection: props reconciliation (review fix)", () => {
  it("same-student refreshed props (e.g. a reversal elsewhere revalidated the page) show the newly reversed payment correctly", () => {
    const { rerender } = renderSection({ initialRows: [ROW_1], initialCursor: null });
    expect(screen.queryByText("Reversed")).toBeNull();

    const reversedRow1 = { ...ROW_1, reversedAt: "2030-01-20T00:00:00.000Z" };
    rerender(sectionElement({ initialRows: [reversedRow1], initialCursor: null }));

    expect(screen.getByText("Reversed")).toBeTruthy();
    expect(screen.getAllByText("$ 100.00").length).toBe(1); // the refreshed snapshot replaced local state, not appended to it
  });

  it("a pending old load-more request cannot append after refreshed initial data replaces it", async () => {
    const stale = deferred<{ ok: true; rows: typeof STALE_ROW[]; nextCursor: string | null }>();
    getPaymentHistoryPage.mockReturnValueOnce(stale.promise);
    const { rerender } = renderSection({ initialRows: [ROW_1], initialCursor: "cursor-1" });

    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());

    // The server re-rendered with a fresh snapshot (same student) WHILE the stale "load more" is still in flight —
    // this must invalidate it, not merely race it.
    rerender(sectionElement({ initialRows: [ROW_3], initialCursor: null }));
    expect(screen.getByText("$ 300.00")).toBeTruthy();
    expect(screen.queryByText("$ 100.00")).toBeNull();
    expect(screen.queryByText("Load more")).toBeNull(); // the refreshed cursor is null — nothing more to load

    // The stale request finally resolves — its own distinctly-identifiable row (never "100.00"/"200.00"/"300.00",
    // never Jan/Feb/Mar 2030) must never append onto the now-superseded snapshot.
    stale.resolve({ ok: true, rows: [STALE_ROW], nextCursor: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("$ 300.00")).toBeTruthy(); // the fresh row is still there
    expect(screen.queryByText("$ 275.00")).toBeNull(); // the stale row's own amount never appeared
    expect(screen.queryByText("2030-05-05")).toBeNull(); // nor its own date
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("an initial failure followed by successful refreshed props shows the rows, not a stale empty/failed state", () => {
    const { rerender } = renderSection({ initialRows: [], initialCursor: null, initialFailed: true });
    expect(screen.getByText("Couldn't load ledger payment history.")).toBeTruthy();

    rerender(sectionElement({ initialRows: [ROW_1], initialCursor: null, initialFailed: false }));

    expect(screen.queryByText("Couldn't load ledger payment history.")).toBeNull();
    expect(screen.getByText("$ 100.00")).toBeTruthy();
  });

  it("an identity change (different student) also resyncs state, never showing the previous student's rows", () => {
    const { rerender } = renderSection({ organizationId: "org-1", studentId: "student-1", initialRows: [ROW_1], initialCursor: null });
    expect(screen.getByText("$ 100.00")).toBeTruthy();

    rerender(sectionElement({ organizationId: "org-1", studentId: "student-2", initialRows: [ROW_3], initialCursor: null }));

    expect(screen.queryByText("$ 100.00")).toBeNull();
    expect(screen.getByText("$ 300.00")).toBeTruthy();
  });
});

describe("PaymentHistorySection: historical display completeness (review fix)", () => {
  it("reversed payment → later waiver → re-settlement: both payments keep their own distinct original breakdown, and the fee's CURRENT state is correctly qualified as such", () => {
    // P1: the ORIGINAL settlement included the late fee (then unwaived) and was later reversed. Its own historical
    // breakdown — principal + the fee IT included — must never change just because the fee was waived afterward.
    const p1 = {
      ...ROW_1,
      id: "pay-waiver-1",
      tenderAmount: "60.00",
      reversedAt: "2030-01-25T00:00:00.000Z",
      settlements: [
        {
          id: "settlement-1",
          reversedAt: "2030-01-25T00:00:00.000Z",
          obligationId: "ob-1",
          obligationType: "MONTHLY" as const,
          coverageYear: 2030,
          coverageMonth: 1,
          currency: "USD" as const,
          principalAmount: "50.00",
          lateFee: { id: "fee-1", amount: "10.00", removalKind: "WAIVED" as const },
          totalAmount: "60.00",
        },
      ],
    };
    // P2: the RE-settlement, made after the fee was waived, never included it — its own total is principal only.
    const p2 = {
      ...ROW_1,
      id: "pay-waiver-2",
      tenderAmount: "50.00",
      receivedOn: { year: 2030, month: 2, day: 1 },
      settlements: [
        {
          id: "settlement-2",
          reversedAt: null,
          obligationId: "ob-1",
          obligationType: "MONTHLY" as const,
          coverageYear: 2030,
          coverageMonth: 1,
          currency: "USD" as const,
          principalAmount: "50.00",
          lateFee: null,
          totalAmount: "50.00",
        },
      ],
    };
    renderSection({ initialRows: [p2, p1], initialCursor: null });

    expect(screen.getByText("Reversed")).toBeTruthy(); // exactly P1
    // P1's distinct breakdown: principal + fee = total, never collapsed into a single total-only figure.
    expect(screen.getByText(/\$ 50\.00 \+ \$ 10\.00 fee = \$ 60\.00/)).toBeTruthy();
    // The fee's CURRENT state is labeled as exactly that — never implying P1's own settlement waived anything.
    expect(screen.getByText("Included fee is now waived")).toBeTruthy();
    expect(screen.queryByText("WAIVED")).toBeNull(); // the old bare-badge wording is gone

    // P2's own, separate, unchanged breakdown: no fee was ever part of this settlement, so no fee line at all —
    // scoped to `span` (and matched on "MONTHLY") so P2's own tender-amount span (ALSO "$ 50.00") can't collide.
    const p2Settlement = screen.getByText(/MONTHLY.*\$ 50\.00$/, { selector: "span" });
    expect(p2Settlement).toBeTruthy();
  });
});
