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

function renderSection(props: Partial<React.ComponentProps<typeof PaymentHistorySection>> = {}) {
  return render(
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
    </NextIntlClientProvider>,
  );
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
