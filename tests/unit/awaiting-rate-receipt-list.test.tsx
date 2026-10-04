/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Owner awaiting-rate receipt queue brief §5.4 (UI tier): component-level behavior under each `ActionState`/status
 * shape, following the exact established convention `tests/unit/exchange-rate-forms.test.tsx` already uses
 * (`@vitest-environment jsdom`, `@testing-library/react`, `vi.mock()` of the action module, `NextIntlClientProvider`).
 * Every case below uses a `vi.fn()`-mocked action — none hits a real database.
 */

const resolveReceipt = vi.fn();
const cancelReceipt = vi.fn();
const getReceiptStatus = vi.fn();
const listReceipts = vi.fn();
vi.mock("../../src/lib/dues/awaiting-rate-receipt-actions", () => ({ resolveReceipt, cancelReceipt, getReceiptStatus, listReceipts }));

const isActive = vi.fn();
vi.mock("../../src/lib/dues/ledger/activation", () => ({ inactiveLedgerActivation: { isActive: (...args: unknown[]) => isActive(...args) } }));

// next-intl/server's getTranslations refuses to run once it detects a client (jsdom) environment — real in
// production (an RSC never renders under jsdom), but it means AwaitingRateReceiptSection (an async server component)
// cannot call the real one here. Mocked with a minimal dotted-path lookup into the SAME real en.json this file
// already uses for its client-side NextIntlClientProvider assertions, so both sides read identical strings.
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a plain recursive message-tree walk
    const root = namespace.split(".").reduce((node: any, segment) => node[segment], enMessages as any);
    return (key: string) => key.split(".").reduce((node: any, segment) => node[segment], root); // eslint-disable-line @typescript-eslint/no-explicit-any
  },
}));

// dues-config-forms.tsx (reused here for TextField) imports config-actions.ts at module scope, which eagerly
// imports `prisma` — unrelated to this feature and unavailable (no DATABASE_URL) in a unit test. Mocked purely to
// short-circuit that transitive import; none of these five are ever called here.
vi.mock("../../src/lib/dues/config-actions", () => ({
  addPlanTerms: vi.fn(), addPolicyVersion: vi.fn(), correctPlanTerms: vi.fn(), correctPolicyVersion: vi.fn(), createPackagePlan: vi.fn(),
}));

const { ReceiptRow, ReceiptQueueList } = await import("../../src/app/[locale]/(staff)/payments/plans/awaiting-rate-receipt-list");
const { AwaitingRateReceiptSection } = await import("../../src/app/[locale]/(staff)/payments/plans/awaiting-rate-receipt-section");

function withMessages(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

const R = enMessages.payments.plans.receipts;

const PENDING_ORDINARY_ROW = {
  id: "r1", studentId: "s1", studentName: "Ana Perez", academyId: "a1", kind: "ORDINARY" as const, status: "PENDING" as const,
  receivedOn: { year: 2031, month: 1, day: 5 }, tenderCurrency: "CRC", tenderAmount: "50000.00", method: "EFECTIVO",
  notes: null, capturedAt: "2031-01-05T12:00:00.000Z", capturedByEmail: "admin@example.com",
  resolvedAt: null, resolvedByEmail: null, cancelledAt: null, cancelledByEmail: null, cancellationReason: null,
  proposal: { ok: true as const, existingObligationIds: ["ob1"] },
};

beforeEach(() => {
  resolveReceipt.mockReset();
  cancelReceipt.mockReset();
  getReceiptStatus.mockReset();
  listReceipts.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  isActive.mockReset();
});

describe("AwaitingRateReceiptSection: inactive pre-check rendering (mocked isActive)", () => {
  it("renders the explanatory unavailable text and no queue when isActive resolves false", async () => {
    isActive.mockResolvedValue(false);
    render(withMessages(await AwaitingRateReceiptSection({ organizationId: "org-1" })));
    expect(screen.getByText(R.inactive)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the queue list when isActive resolves true", async () => {
    isActive.mockResolvedValue(true);
    render(withMessages(await AwaitingRateReceiptSection({ organizationId: "org-1" })));
    expect(screen.getByText(R.tabs.PENDING)).toBeTruthy();
  });
});

describe("ReceiptQueueList: tabs, pagination, and empty/failed states", () => {
  it("fetches PENDING on mount and renders the empty message when there are no rows", async () => {
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "PENDING", cursor: undefined }));
    await waitFor(() => expect(screen.getByText(R.empty)).toBeTruthy());
  });

  it("switching tabs re-fetches for the new status", async () => {
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "PENDING", cursor: undefined }));
    fireEvent.click(screen.getByText(R.tabs.RESOLVED));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "RESOLVED", cursor: undefined }));
  });

  it("a rejected fetch shows an explicit failure message with a Retry control that re-fetches", async () => {
    listReceipts.mockRejectedValueOnce(new Error("network down"));
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(screen.getByText(R.loadFailed)).toBeTruthy());

    listReceipts.mockResolvedValueOnce({ rows: [PENDING_ORDINARY_ROW], nextCursor: null });
    fireEvent.click(screen.getByText(R.retry));
    await waitFor(() => expect(screen.getByText("Ana Perez")).toBeTruthy());
  });

  it("a page with rows shows a Load more button only when nextCursor is present, and paging appends rows via the real cursor", async () => {
    listReceipts.mockResolvedValueOnce({ rows: [PENDING_ORDINARY_ROW], nextCursor: "r1" });
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(screen.getByText("Ana Perez")).toBeTruthy());
    expect(screen.getByText(R.loadMore)).toBeTruthy();

    const SECOND_ROW = { ...PENDING_ORDINARY_ROW, id: "r2", studentName: "Beto Soto" };
    listReceipts.mockResolvedValueOnce({ rows: [SECOND_ROW], nextCursor: null });
    fireEvent.click(screen.getByText(R.loadMore));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "PENDING", cursor: "r1" }));
    await waitFor(() => expect(screen.getByText("Beto Soto")).toBeTruthy());
    expect(screen.getByText("Ana Perez")).toBeTruthy(); // appended, not replaced
    expect(screen.queryByText(R.loadMore)).toBeNull(); // nextCursor null now
  });
});

describe("ReceiptQueueList: request-identity races (bug fix) — a stale response never overwrites a current one", () => {
  it("switching PENDING -> CANCELLED: if the PENDING request resolves SECOND (out of order), its rows never overwrite CANCELLED's own rows", async () => {
    let resolvePending!: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => (resolvePending = resolve));
    let resolveCancelled!: (value: unknown) => void;
    const cancelledPromise = new Promise((resolve) => (resolveCancelled = resolve));
    listReceipts.mockImplementationOnce(() => pendingPromise).mockImplementationOnce(() => cancelledPromise);

    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "PENDING", cursor: undefined }));
    fireEvent.click(screen.getByText(R.tabs.CANCELLED));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "CANCELLED", cursor: undefined }));

    const CANCELLED_ROW = { ...PENDING_ORDINARY_ROW, id: "cancelled-1", studentName: "Cancelled Row", status: "CANCELLED" as const };
    // Resolve the NEWER (currently-displayed) tab's request FIRST...
    resolveCancelled({ rows: [CANCELLED_ROW], nextCursor: null });
    await waitFor(() => expect(screen.getByText("Cancelled Row")).toBeTruthy());
    // ...then the SLOWER, now-superseded PENDING request resolves AFTER — it must be discarded, not applied.
    const STALE_PENDING_ROW = { ...PENDING_ORDINARY_ROW, id: "stale-pending", studentName: "Stale Pending Row" };
    resolvePending({ rows: [STALE_PENDING_ROW], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale Pending Row")).toBeNull();
    expect(screen.getByText("Cancelled Row")).toBeTruthy();
  });

  it("a 'load more' request that resolves AFTER the tab has since changed never has its rows appended to the new tab's list", async () => {
    listReceipts.mockResolvedValueOnce({ rows: [PENDING_ORDINARY_ROW], nextCursor: "r1" });
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(screen.getByText("Ana Perez")).toBeTruthy());

    let resolveLoadMore!: (value: unknown) => void;
    listReceipts.mockImplementationOnce(() => new Promise((resolve) => (resolveLoadMore = resolve)));
    fireEvent.click(screen.getByText(R.loadMore));

    // The tab changes WHILE the "load more" request is still in flight.
    listReceipts.mockResolvedValueOnce({ rows: [], nextCursor: null });
    fireEvent.click(screen.getByText(R.tabs.RESOLVED));
    await waitFor(() => expect(screen.getByText(R.empty)).toBeTruthy());

    // The stale "load more" response arrives late — it must never be appended to the (now RESOLVED) list.
    const STALE_NEXT_PAGE_ROW = { ...PENDING_ORDINARY_ROW, id: "stale-next-page", studentName: "Stale Next Page Row" };
    resolveLoadMore({ rows: [STALE_NEXT_PAGE_ROW], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale Next Page Row")).toBeNull();
    expect(screen.getByText(R.empty)).toBeTruthy();
  });

  it("a REJECTED response for an obsolete (superseded by a tab switch) request never flips loadStatus to failed once the newer request already succeeded", async () => {
    let rejectPending!: (reason: unknown) => void;
    listReceipts.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectPending = reject)));
    render(withMessages(<ReceiptQueueList organizationId="org-1" />));
    await waitFor(() => expect(listReceipts).toHaveBeenCalledWith("org-1", { status: "PENDING", cursor: undefined }));

    listReceipts.mockResolvedValueOnce({ rows: [PENDING_ORDINARY_ROW], nextCursor: null });
    fireEvent.click(screen.getByText(R.tabs.RESOLVED)); // supersedes the still-pending PENDING request
    await waitFor(() => expect(screen.getByText("Ana Perez")).toBeTruthy());

    // The original PENDING request, now obsolete, finally rejects.
    rejectPending(new Error("late failure for a superseded request"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(R.loadFailed)).toBeNull(); // never flipped to failed by the stale rejection
    expect(screen.getByText("Ana Perez")).toBeTruthy(); // the current (RESOLVED-tab) rows are untouched
  });
});

describe("ReceiptRow: PENDING shows working controls, RESOLVED/CANCELLED show none", () => {
  it("a PENDING row renders Resolve and Cancel", () => {
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(R.resolve)).toBeTruthy();
    expect(screen.getByText(R.cancel)).toBeTruthy();
    expect(screen.getByText(R.cancelDisclaimer)).toBeTruthy();
  });

  it("a RESOLVED row renders no Resolve/Cancel controls", () => {
    const row = { ...PENDING_ORDINARY_ROW, status: "RESOLVED" as const };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.queryByText(R.resolve)).toBeNull();
    expect(screen.queryByText(R.cancel)).toBeNull();
  });

  it("a CANCELLED row renders no Resolve/Cancel controls", () => {
    const row = { ...PENDING_ORDINARY_ROW, status: "CANCELLED" as const };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.queryByText(R.resolve)).toBeNull();
    expect(screen.queryByText(R.cancel)).toBeNull();
  });
});

describe("ReceiptRow: mutual exclusion between Resolve and Cancel on the same row", () => {
  it("clicking Resolve disables the Cancel submit button until the mocked call settles", async () => {
    let resolvePromise!: (value: unknown) => void;
    resolveReceipt.mockReturnValue(new Promise((resolve) => (resolvePromise = resolve)));
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    const resolveButton = screen.getByText(R.resolve).closest("button") as HTMLButtonElement;
    const cancelButton = screen.getByText(R.cancel).closest("button") as HTMLButtonElement;
    expect(resolveButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(false);

    fireEvent.click(resolveButton);
    await waitFor(() => expect(resolveButton.disabled).toBe(true));
    expect(cancelButton.disabled).toBe(true); // coordinated: one busy flag for the whole row

    // Resolve with a non-terminal failure (not ok:true) so the row stays actionable and the SAME DOM nodes can be
    // re-checked afterward — an ok:true success removes these controls entirely, which a different test covers.
    resolvePromise({ error: "invalid" });
    await waitFor(() => expect(resolveButton.disabled).toBe(false));
    expect(cancelButton.disabled).toBe(false);
  });

  it("clicking Cancel disables the Resolve button until the mocked call settles", async () => {
    let resolveCancel!: (value: unknown) => void;
    cancelReceipt.mockReturnValue(new Promise((resolve) => (resolveCancel = resolve)));
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.change(screen.getByLabelText(R.fields.cancellationReason), { target: { value: "no longer needed" } });
    const resolveButton = screen.getByText(R.resolve).closest("button") as HTMLButtonElement;
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(resolveButton.disabled).toBe(true));

    resolveCancel({ error: "invalid" });
    await waitFor(() => expect(resolveButton.disabled).toBe(false));
  });
});

describe("ReceiptRow: terminal-status refresh on alreadyResolved/alreadyCancelled", () => {
  it("an alreadyResolved result triggers getReceiptStatus and removes the controls once confirmed RESOLVED", async () => {
    resolveReceipt.mockResolvedValue({ error: "alreadyResolved" });
    getReceiptStatus.mockResolvedValue({ status: "RESOLVED" });
    const onStatusChanged = vi.fn();
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={onStatusChanged} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(getReceiptStatus).toHaveBeenCalledWith("org-1", "r1"));
    await waitFor(() => expect(screen.queryByText(R.resolve)).toBeNull());
    expect(onStatusChanged).toHaveBeenCalledWith("r1", "RESOLVED");
  });

  it("a REJECTED status-refresh shows an explicit failure message with a retry, and BLOCKS writes (by disabling, not hiding, the controls) for the whole recovery window", async () => {
    resolveReceipt.mockResolvedValue({ error: "alreadyCancelled" });
    getReceiptStatus.mockRejectedValue(new Error("network down"));
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.statusRefreshFailed)).toBeTruthy());
    expect(screen.getByText(R.retry)).toBeTruthy();
    // The controls stay MOUNTED (bug fix: an earlier version hid them, which destroyed the Cancel form's uncontrolled
    // reason input via unmount) but are DISABLED for the entire recovery window.
    expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(R.cancel).closest("button") as HTMLButtonElement).disabled).toBe(true);

    getReceiptStatus.mockResolvedValue({ status: "CANCELLED" });
    fireEvent.click(screen.getByText(R.retry));
    await waitFor(() => expect(screen.getByText(R.tabs.CANCELLED)).toBeTruthy());
    expect(screen.queryByText(R.resolve)).toBeNull(); // NOW genuinely terminal — the block is gone for good
  });

  it("a status-refresh resolving to null (notFound) gets its own distinct message, different from a rejected fetch, and also disables writes", async () => {
    resolveReceipt.mockResolvedValue({ error: "alreadyResolved" });
    getReceiptStatus.mockResolvedValue(null);
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.statusRefreshNotFound)).toBeTruthy());
    expect(screen.queryByText(R.statusRefreshFailed)).toBeNull();
    expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("writes stay disabled (and dispatch nothing further) throughout the refresh-loading window itself, not just after it settles", async () => {
    resolveReceipt.mockResolvedValue({ error: "alreadyResolved" });
    let resolveStatusFetch!: (value: unknown) => void;
    getReceiptStatus.mockReturnValue(new Promise((resolve) => (resolveStatusFetch = resolve)));
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.statusRefreshing)).toBeTruthy());
    expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(resolveReceipt).toHaveBeenCalledTimes(1);

    resolveStatusFetch({ status: "RESOLVED" });
    await waitFor(() => expect(screen.getByText(R.tabs.RESOLVED)).toBeTruthy());
    expect(screen.queryByText(R.resolve)).toBeNull(); // genuinely terminal now
  });

  it("a refresh confirming PENDING clears the error and makes the row actionable again, never locking it out forever (bug fix)", async () => {
    resolveReceipt.mockReset();
    resolveReceipt.mockResolvedValueOnce({ error: "alreadyResolved" }).mockResolvedValueOnce({ ok: true });
    getReceiptStatus.mockResolvedValue({ status: "PENDING" }); // the previous attempt genuinely did not take effect
    const onStatusChanged = vi.fn();
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={onStatusChanged} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(getReceiptStatus).toHaveBeenCalledWith("org-1", "r1"));
    // No success claimed, no longer locked: the Resolve button is present AND re-enabled.
    await waitFor(() => expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(R.actionSuccess)).toBeNull();
    expect(onStatusChanged).not.toHaveBeenCalled(); // PENDING === the row's own current status — nothing "changed"
    expect(resolveReceipt).toHaveBeenCalledTimes(1); // no auto-resubmission from the PENDING confirmation itself

    // A fresh, explicit retry now succeeds normally.
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(resolveReceipt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(R.actionSuccess)).toBeTruthy());
  });
});

describe("ReceiptRow: a transport failure (rejected promise) on Resolve/Cancel, never a permanently-stuck busy state (bug fix)", () => {
  it("a rejected resolveReceipt releases busy, shows an honest message, disables (not hides) the control during recovery, then removes it once genuinely terminal", async () => {
    resolveReceipt.mockRejectedValue(new Error("network down"));
    let resolveStatusFetch!: (value: unknown) => void;
    getReceiptStatus.mockReturnValue(new Promise((resolve) => (resolveStatusFetch = resolve)));
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    const resolveButton = screen.getByText(R.resolve).closest("button") as HTMLButtonElement;
    fireEvent.click(resolveButton);
    await waitFor(() => expect(screen.getByText(R.error.transportFailure)).toBeTruthy());
    // Writes stay blocked (disabled, still present) until the refresh confirms what actually happened — never
    // auto-resubmitted, never claimed safe.
    expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(true);

    // The refresh now confirms the write actually DID commit despite the transport failure — this is the genuine
    // terminal path, unchanged from before this round's fix.
    resolveStatusFetch({ status: "RESOLVED" });
    await waitFor(() => expect(screen.getByText(R.tabs.RESOLVED)).toBeTruthy());
    expect(screen.queryByText(R.resolve)).toBeNull();
  });

  it("a rejected resolveReceipt whose refresh confirms PENDING (the write genuinely did not take effect) clears the lockout and allows a real second attempt", async () => {
    resolveReceipt.mockReset();
    resolveReceipt.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ ok: true });
    getReceiptStatus.mockResolvedValue({ status: "PENDING" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.error.transportFailure)).toBeTruthy());
    await waitFor(() => expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(R.actionSuccess)).toBeNull();
    expect(resolveReceipt).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(resolveReceipt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(R.actionSuccess)).toBeTruthy());
  });

  it("a rejected cancelReceipt preserves the typed reason through the mounted (not unmounted) form, re-queried live from the DOM, not held from before the refusal", async () => {
    cancelReceipt.mockReset();
    cancelReceipt.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ ok: true });
    getReceiptStatus.mockResolvedValue({ status: "PENDING" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));

    fireEvent.change(screen.getByLabelText(R.fields.cancellationReason), { target: { value: "owner changed their mind" } });
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(screen.getByText(R.error.transportFailure)).toBeTruthy());
    // Re-queried live — never a reference held from before the refusal — proving the field is the SAME surviving
    // DOM node, not a coincidentally-equal one from a fresh mount.
    expect((screen.getByLabelText(R.fields.cancellationReason) as HTMLInputElement).value).toBe("owner changed their mind");

    await waitFor(() => expect((screen.getByText(R.cancel).closest("button") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText(R.fields.cancellationReason) as HTMLInputElement).value).toBe("owner changed their mind");

    // Submitting again dispatches the ORIGINAL typed reason, not blank and not reset.
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(cancelReceipt).toHaveBeenCalledTimes(2));
    const secondCallFormData = cancelReceipt.mock.calls[1][2] as FormData;
    expect(secondCallFormData.get("reason")).toBe("owner changed their mind");
  });

  it("busy returns to idle (not stuck forever) after a rejected call, even while recovery is pending", async () => {
    resolveReceipt.mockRejectedValue(new Error("network down"));
    getReceiptStatus.mockReturnValue(new Promise(() => {})); // never resolves
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.error.transportFailure)).toBeTruthy());
    // Present (not hidden) but disabled — nothing left permanently spinning/clickable purely due to the
    // try/catch/finally itself; the refresh's own in-flight state is what's gating it.
    expect((screen.getByText(R.resolve).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ReceiptRow: distinct error messages — drift, malformed-snapshot, and already-handled never share a message", () => {
  it("renders a distinct message for a drift case (staleTerms)", async () => {
    resolveReceipt.mockResolvedValue({ error: "staleTerms" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.error.drifted)).toBeTruthy());
  });

  it("renders a distinct message for malformedSnapshot", async () => {
    resolveReceipt.mockResolvedValue({ error: "malformedSnapshot" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.error.malformedSnapshot)).toBeTruthy());
  });

  it("renders a distinct message for alreadyResolved, different from staleTerms and malformedSnapshot", async () => {
    resolveReceipt.mockResolvedValue({ error: "alreadyResolved" });
    getReceiptStatus.mockResolvedValue({ status: "RESOLVED" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.queryByText(R.resolve)).toBeNull());
    expect(screen.queryByText(R.error.drifted)).toBeNull();
    expect(screen.queryByText(R.error.malformedSnapshot)).toBeNull();
  });

  it("the unreachable futureDate/tooOld/captured members get their own distinct unexpected-state message", async () => {
    resolveReceipt.mockResolvedValue({ error: "captured" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.resolve));
    await waitFor(() => expect(screen.getByText(R.error.unexpected)).toBeTruthy());
  });
});

describe("ReceiptRow: blank-reason Cancel refuses without discarding state, preserves typed reason on failure", () => {
  it("a blank reason gets invalid back from the (mocked) action and the typed value (none, blank) is not force-cleared", async () => {
    cancelReceipt.mockResolvedValue({ error: "invalid" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(screen.getByText(R.error.invalid)).toBeTruthy());
  });

  it("a non-blank reason is preserved in the field after a refusal (form.reset() only fires on ok:true)", async () => {
    cancelReceipt.mockResolvedValue({ error: "notFound" });
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    const reasonInput = screen.getByLabelText(R.fields.cancellationReason) as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: "owner changed their mind" } });
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(screen.getByText(R.error.notFound)).toBeTruthy());
    expect(reasonInput.value).toBe("owner changed their mind");
  });

  it("a successful cancel clears the reason field", async () => {
    cancelReceipt.mockResolvedValue({ ok: true });
    const onStatusChanged = vi.fn();
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={onStatusChanged} />));
    const reasonInput = screen.getByLabelText(R.fields.cancellationReason) as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: "owner changed their mind" } });
    fireEvent.click(screen.getByText(R.cancel));
    await waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith("r1", "CANCELLED"));
  });
});

describe("ReceiptRow: status-correct tense for captured proposals (PENDING vs RESOLVED vs CANCELLED)", () => {
  const prepaymentProposal = { ok: true as const, existingObligationIds: [], proposedCoverage: [{ year: 2031, month: 6 }] };

  it("a PENDING row says the coverage is proposed, not yet created", () => {
    const row = { ...PENDING_ORDINARY_ROW, proposal: prepaymentProposal };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(R.proposedPending.replace("{months}", "2031-06"))).toBeTruthy();
  });

  it("a RESOLVED row describes the coverage as captured and created on resolution, not still pending", () => {
    const row = { ...PENDING_ORDINARY_ROW, status: "RESOLVED" as const, proposal: prepaymentProposal };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(R.proposedResolved.replace("{months}", "2031-06"))).toBeTruthy();
    expect(screen.queryByText(R.proposedPending.replace("{months}", "2031-06"))).toBeNull();
  });

  it("a CANCELLED row describes the coverage as proposed but never created", () => {
    const row = { ...PENDING_ORDINARY_ROW, status: "CANCELLED" as const, proposal: prepaymentProposal };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(R.proposedCancelled.replace("{months}", "2031-06"))).toBeTruthy();
  });

  it("a snapshotIntegrityFailure row renders the explicit integrity message, never a coverage summary", () => {
    const row = { ...PENDING_ORDINARY_ROW, proposal: { ok: false as const, reason: "snapshotIntegrityFailure" as const } };
    render(withMessages(<ReceiptRow organizationId="org-1" row={row} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(R.snapshotIntegrityFailure)).toBeTruthy();
  });

  it("existing referenced obligations are labeled 'referenced', never 'unpaid'", () => {
    render(withMessages(<ReceiptRow organizationId="org-1" row={PENDING_ORDINARY_ROW} onStatusChanged={vi.fn()} />));
    expect(screen.getByText(/referenced existing obligation/i)).toBeTruthy();
    expect(screen.queryByText(/unpaid/i)).toBeNull();
  });
});
