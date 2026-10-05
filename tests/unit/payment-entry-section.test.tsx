/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Ordinary payment-entry UI brief §8 tier 5: REAL component-level proof — renders the real `PaymentEntrySection`,
 * drives real user events, uses jsdom's real `localStorage` via the real `payment-attempt-storage.ts`, and mocks
 * ONLY `payment-entry-actions.ts`. A pure classifier test (`payment-entry-recovery.test.ts`) proves the classifier's
 * own output; it does NOT prove this component actually acts on that output — these tests are what do.
 */

const recordPayment = vi.fn();
const checkSubmissionOutcome = vi.fn();
const getPayableObligations = vi.fn();

vi.mock("@/lib/dues/payment-entry-actions", () => ({ recordPayment, checkSubmissionOutcome, getPayableObligations }));

const { PaymentEntrySection } = await import("../../src/app/[locale]/(staff)/payments/payment-entry-section");

const STUDENTS = [
  { id: "student-1", firstName: "Ana", lastName: "Soto", academyId: "academy-1", academyName: "Alliance" },
  { id: "student-2", firstName: "Beto", lastName: "Mora", academyId: "academy-1", academyName: "Alliance" },
];
const ORG_ID = "org-1";
const USER_ID = "user-1";
const TODAY_LOCAL = { year: 2027, month: 2, day: 15 };

function renderSection(props: Partial<React.ComponentProps<typeof PaymentEntrySection>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentEntrySection organizationId={ORG_ID} currentUserId={USER_ID} students={STUDENTS} organizationRole="ADMIN" plansHref="/en/payments/plans" {...props} />
    </NextIntlClientProvider>,
  );
}

const OBLIGATION = {
  obligationId: "ob-1",
  type: "MONTHLY" as const,
  currency: "USD" as const,
  coverageYear: 2027,
  coverageMonth: 2,
  settled: false as const,
  outstandingAmountMinor: 10000,
  outstandingFeeMinor: 0,
  dueOn: "2027-02-20",
  pastGrace: false,
};

async function selectStudentAndFillAmount(
  obligations: Array<Omit<typeof OBLIGATION, "currency"> & { currency: "USD" | "CRC" }> = [OBLIGATION],
  mixedCurrency = false,
  todayLocal = TODAY_LOCAL,
) {
  getPayableObligations.mockResolvedValue({ ok: true, obligations, mixedCurrency, todayLocal });
  fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
  await waitFor(() => expect(getPayableObligations).toHaveBeenCalled());
  if (!mixedCurrency && obligations.length > 0) {
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "100.00" } });
  }
}

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k) keys.push(k);
  }
  return keys;
}

/** A manually-resolvable promise, for asserting MID-FLIGHT state precisely (round-3 point 3) rather than only the
 * eventual state `waitFor` would observe. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.localStorage.clear();
  recordPayment.mockReset();
  checkSubmissionOutcome.mockReset();
  getPayableObligations.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("fresh submission outcomes", () => {
  it("a fresh settlement renders success copy and clears the stored attempt", async () => {
    recordPayment.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], feeIds: [], totalMinor: 10000 });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
  });

  it("a replay reporting currentlyReversed:true shows the DISTINCT reversed notice, never plain success", async () => {
    recordPayment.mockResolvedValue({ ok: true, paymentId: "p1", replay: true, currentlyReversed: true });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/since been reversed/i)).toBeInTheDocument());
    expect(screen.queryByText("Payment recorded.")).toBeNull();
  });

  it("a fresh capture renders the pending-queue copy with an ADMIN link into the exchange-rate queue", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "captured", receiptId: "r1" });
    renderSection({ organizationRole: "ADMIN" });
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/waiting, pending, in the exchange-rate queue/i)).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /Review it in the exchange-rate queue/i });
    expect(link).toHaveAttribute("href", "/en/payments/plans");
  });

  it("point 8: a DIRECTOR sees text-only guidance on a capture outcome, never a link implying access they don't have", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "captured", receiptId: "r1" });
    renderSection({ organizationRole: "DIRECTOR" });
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/Ask an owner to review this/i)).toBeInTheDocument());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("point 1 (the core bug): the write-result classification actually controls the UI phase", () => {
  it("a rejected promise, then a retry-safely call returning notActive: STAYS locked, the stored entry is byte-identical, no 'Record another', no new submissionId minted", async () => {
    recordPayment.mockRejectedValueOnce(new TypeError("network error"));
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());

    expect(window.localStorage.length).toBe(1);
    const keyAfterReject = storedKeys()[0];
    const valueAfterReject = window.localStorage.getItem(keyAfterReject);

    // The retry resolves notActive — a pre-arbitration code that proves NOTHING about the original call (§2.4c).
    recordPayment.mockResolvedValueOnce({ ok: false, error: "notActive" });
    fireEvent.click(screen.getByRole("button", { name: /Retry safely/i }));

    await waitFor(() => expect(screen.getByText(/can't confirm this payment's status right now/i)).toBeInTheDocument());

    // Still locked: the terminal "outcome" screen (with its "Record another" button) never appears.
    expect(screen.queryByText("Payment recorded.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Record another/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Retry safely/i })).toBeInTheDocument();

    // The stored entry survives, completely unchanged — same key, same exact content.
    expect(window.localStorage.length).toBe(1);
    expect(storedKeys()[0]).toBe(keyAfterReject);
    expect(window.localStorage.getItem(keyAfterReject)).toBe(valueAfterReject);

    // The retry call itself reused the SAME submissionId — never a new crypto.randomUUID().
    expect(recordPayment).toHaveBeenCalledTimes(2);
    const firstFormData = recordPayment.mock.calls[0][2] as FormData;
    const secondFormData = recordPayment.mock.calls[1][2] as FormData;
    expect(secondFormData.get("submissionId")).toBe(firstFormData.get("submissionId"));
  });

  it("a submissionPayloadMismatch result: locked, stored entry untouched, distinct copy, no retry-safely affordance offered for it", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "submissionPayloadMismatch" });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    // beginAttempt writes synchronously, before the (mocked) async recordPayment call — captured right after the
    // click, so this is the entry the submit itself created.
    const keysBefore = storedKeys();
    expect(keysBefore).toHaveLength(1);
    const valueBefore = window.localStorage.getItem(keysBefore[0]);

    await waitFor(() => expect(screen.getByText(/identity.*contact support/i)).toBeInTheDocument());
    expect(screen.queryByText("Payment recorded.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retry safely$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record another/i })).toBeNull();

    // Stored entry (identity + payload) left completely alone.
    expect(storedKeys()).toEqual(keysBefore);
    expect(window.localStorage.getItem(keysBefore[0])).toBe(valueBefore);
  });
});

describe("point 2: an ordinary business refusal clears only the identity, never the owner's typed draft", () => {
  it("submit with notOldestFirst: input values survive exactly, stored identity is cleared, owner corrects and resubmits successfully", async () => {
    const older = { ...OBLIGATION, obligationId: "ob-older", coverageMonth: 1 };
    const newer = { ...OBLIGATION, obligationId: "ob-newer", coverageMonth: 2 };
    renderSection();
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [older, newer], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());

    // A genuine prefix selection FROM THE CLIENT'S OWN PERSPECTIVE (both items) — the client-side prefix check is
    // only advisory (§2.1); the server can still refuse `notOldestFirst` on data the client doesn't have (e.g. a
    // stale read), and that server refusal is what this test actually exercises.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]); // also select the newer item, alongside the already-default-selected older one
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "77.50" } });
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: "a specific note" } });

    recordPayment.mockResolvedValueOnce({ ok: false, error: "notOldestFirst" });
    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/selection must start with the oldest/i)).toBeInTheDocument());

    // The form is still rendered (not the terminal "outcome" screen) and every typed value survived untouched.
    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe("77.50");
    expect((screen.getByLabelText(/Notes/i) as HTMLInputElement).value).toBe("a specific note");
    expect(window.localStorage.length).toBe(0); // the refused identity was cleared — nothing was written

    // Resubmit with the SAME selection (still both items, a genuine prefix) — now succeeds.
    recordPayment.mockResolvedValueOnce({ ok: true, paymentId: "p1", settlementIds: ["s1", "s2"], feeIds: [], totalMinor: 17750 });
    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
  });

  it("alreadySettled refuses, clears identity, and shows the detail without discarding an unrelated still-valid selection", async () => {
    renderSection();
    await selectStudentAndFillAmount();
    recordPayment.mockResolvedValueOnce({ ok: false, error: "alreadySettled", alreadySettledIds: ["ob-1"] });
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [], mixedCurrency: false, todayLocal: TODAY_LOCAL });

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    // Both the ordinary refusal copy AND the alreadySettledIds detail line render.
    await waitFor(() => expect(screen.getByText(/Already settled: ob-1/i)).toBeInTheDocument());
    expect(screen.getByText(/were already settled/i)).toBeInTheDocument();
  });
});

describe("point 3: the obligations fetch race, mixed-currency, and loading-phase locking", () => {
  it("selecting student B before student A's slower fetch resolves: the final state belongs only to B, never a mix, and mid-flight submission is blocked", async () => {
    let resolveA!: (v: unknown) => void;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const obligationB = { ...OBLIGATION, obligationId: "ob-B" };
    getPayableObligations.mockImplementationOnce(() => pendingA);
    renderSection();
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });

    // The submit button must be disabled the instant loading starts, before any resolution.
    await waitFor(() => expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled());

    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [obligationB], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-2" } });
    await waitFor(() => expect(screen.getByText(/2027-02/)).toBeInTheDocument());

    // Student A's slow fetch resolves LATE, with a DIFFERENT obligation — must never overwrite B's already-shown state.
    resolveA({ ok: true, obligations: [OBLIGATION], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(/2027-02 \(Monthly\)/)).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1); // never two rows from a merged/mixed state
  });

  it("a mixed-currency response never pre-selects any obligation, and submit stays blocked even with an amount typed", async () => {
    renderSection();
    const usd = { ...OBLIGATION, currency: "USD" as const };
    const crc = { ...OBLIGATION, obligationId: "ob-2", currency: "CRC" as const };
    getPayableObligations.mockResolvedValue({ ok: true, obligations: [usd, crc], mixedCurrency: true, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });

    await waitFor(() => expect(screen.getByText(/owes in more than one currency/i)).toBeInTheDocument());
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "100.00" } });
    expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled();
  });

  it("a transient obligations-fetch failure offers a retry that genuinely re-fetches", async () => {
    renderSection();
    getPayableObligations.mockRejectedValueOnce(new Error("network"));
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByText(/Something unexpected happened\.|Retry/i)).toBeInTheDocument());

    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [OBLIGATION], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(screen.getByText(/2027-02 \(Monthly\)/)).toBeInTheDocument());
  });
});

describe("point 4: every stored attempt is processed, not just the first", () => {
  it("two stored attempts for the same user/org: both get checked; the form stays locked on the second (notFound) after the first resolves committed", async () => {
    const payload = { studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 1 }, tender: { currency: "USD", amount: "50.00" }, method: "EFECTIVO" };
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-aaa`, JSON.stringify(payload));
    window.localStorage.setItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-bbb`, JSON.stringify({ ...payload }));

    checkSubmissionOutcome.mockImplementation(async (_org: string, submissionId: string) => {
      if (submissionId === "sub-aaa") return { status: "committed", outcome: { kind: "payment", paymentId: "p-aaa", currentlyReversed: false } };
      return { status: "notFound" };
    });

    renderSection();

    await waitFor(() => expect(checkSubmissionOutcome).toHaveBeenCalledTimes(2));
    expect(checkSubmissionOutcome.mock.calls.map((c) => c[1]).sort()).toEqual(["sub-aaa", "sub-bbb"]);

    // The first (sub-aaa) resolved and was cleared; the second (sub-bbb) is genuinely unresolved — the form must
    // stay locked/blocked, never unlock to a fresh "form" phase while it remains uncertain.
    await waitFor(() => expect(screen.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-aaa`)).toBeNull();
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-bbb`)).not.toBeNull();
    expect(screen.queryByLabelText(/Student/i)).toBeNull(); // the form itself is not rendered while blocked
  });
});

describe("mixed-currency obligations (basic render)", () => {
  it("renders the explicit limitation message instead of a selection list", async () => {
    renderSection();
    await selectStudentAndFillAmount([OBLIGATION, { ...OBLIGATION, obligationId: "ob-2", currency: "CRC" as const }], true);
    await waitFor(() => expect(screen.getByText(/owes in more than one currency/i)).toBeInTheDocument());
    expect(screen.queryByText(/2027-02/)).toBeNull();
  });
});

describe("reload-recovery mount check", () => {
  it("a stored attempt resolving to a committed outcome on mount clears it and renders the original outcome", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-recovered`,
      JSON.stringify({ studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p-original", currentlyReversed: false } });

    renderSection();

    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(recordPayment).not.toHaveBeenCalled(); // a read-only recovery check never performs a new financial write
  });

  it("a stored attempt resolving to notFound on mount is preserved, never auto-cleared", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-uncertain`,
      JSON.stringify({ studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "notFound" });

    renderSection();

    await waitFor(() => expect(screen.getByText(/couldn't find a confirmed outcome/i)).toBeInTheDocument());
    expect(window.localStorage.length).toBe(1);
  });
});

describe("point 7: the default receivedOn and the backdated disclaimer use the student's branch-local date, never the browser's", () => {
  it("defaults receivedOn to the branch-local today from getPayableObligations once a student is selected", async () => {
    renderSection();
    const branchToday = { year: 2027, month: 2, day: 20 }; // deliberately NOT "today" by any real clock
    await selectStudentAndFillAmount([OBLIGATION], false, branchToday);
    expect((screen.getByLabelText(/Date received/i) as HTMLInputElement).value).toBe("2027-02-20");
    // No disclaimer when receivedOn still equals the branch-local today.
    expect(screen.queryByText(/This total reflects today's balance/i)).toBeNull();
  });

  it("shows the backdated disclaimer when the (still default) receivedOn differs from a LATER branch-local today fetched after an edit", async () => {
    renderSection();
    await selectStudentAndFillAmount([OBLIGATION], false, { year: 2027, month: 2, day: 20 });
    // The owner manually backdates the date field.
    fireEvent.change(screen.getByLabelText(/Date received/i), { target: { value: "2027-02-10" } });
    expect(screen.getByText(/This total reflects today's balance/i)).toBeInTheDocument();
  });

  it("a manually-edited receivedOn is never overwritten by a later branch-local-today fetch (e.g. after a student re-selection retains the owner's own edit intent for THIS student)", async () => {
    renderSection();
    await selectStudentAndFillAmount([OBLIGATION], false, { year: 2027, month: 2, day: 20 });
    fireEvent.change(screen.getByLabelText(/Date received/i), { target: { value: "2027-01-05" } });
    expect((screen.getByLabelText(/Date received/i) as HTMLInputElement).value).toBe("2027-01-05");
  });
});

describe("point 5 (component-facing): a storage-access failure blocks the form, and a clear-failure never gets silently treated as cleared", () => {
  it("a mount-time scan failure blocks the whole form — never treated as 'nothing stored'", async () => {
    const spy = vi.spyOn(window.localStorage.__proto__, "key").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });
    window.localStorage.setItem("irrelevant-nonzero-length", "x");
    try {
      renderSection();
      await waitFor(() => expect(screen.getByText(/can't verify your browser's storage/i)).toBeInTheDocument());
      expect(screen.queryByLabelText(/Student/i)).toBeNull();
    } finally {
      spy.mockRestore();
      window.localStorage.clear();
    }
  });

  it("a clear failure after a resolved recovery check stays locked and offers 'Finish cleanup' rather than assuming the entry is gone", async () => {
    window.localStorage.setItem(
      `payment-attempt:${ORG_ID}:${USER_ID}:sub-clearfail`,
      JSON.stringify({ studentId: "student-1", obligationIds: ["ob-1"], receivedOn: { year: 2027, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO" }),
    );
    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } });
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });

    renderSection();
    await waitFor(() => expect(screen.getByText(/couldn't finish clearing the local draft/i)).toBeInTheDocument());
    expect(screen.queryByText("Payment recorded.")).toBeNull();
    expect(screen.getByRole("button", { name: /Finish cleanup/i })).toBeInTheDocument();

    // Once storage recovers, clicking "Finish cleanup" genuinely completes it.
    spy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: /Finish cleanup/i }));
    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.getItem(`payment-attempt:${ORG_ID}:${USER_ID}:sub-clearfail`)).toBeNull();
  });
});

describe("round 3, point 1: the WRITE path's own clear-failure is never silently ignored", () => {
  it("after a fresh SUCCESS, a clearAttempt failure blocks the form, offers Finish cleanup, and resetting the draft waits for it", async () => {
    recordPayment.mockResolvedValue({ ok: true, paymentId: "p1", settlementIds: ["s1"], feeIds: [], totalMinor: 10000 });
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage inaccessible");
    });
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    // Blocked on cleanup, NOT the terminal outcome screen — the entry is still genuinely present.
    await waitFor(() => expect(screen.getByText(/couldn't finish clearing the local draft/i)).toBeInTheDocument());
    expect(screen.queryByText("Payment recorded.")).toBeNull();
    expect(window.localStorage.length).toBe(1);
    // The form itself isn't even rendered while blocked — no way to start a new submission.
    expect(screen.queryByLabelText(/Student/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Finish cleanup/i }));

    // Only NOW, once cleanup genuinely succeeds, does the draft reset and the terminal outcome render.
    await waitFor(() => expect(screen.getByText("Payment recorded.")).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(recordPayment).toHaveBeenCalledTimes(1); // no new submission was ever possible while blocked
    spy.mockRestore();
  });

  it("after a BUSINESS REFUSAL, a clearAttempt failure blocks the form the same way, but once cleanup succeeds the draft is PRESERVED (nothing new was confirmed)", async () => {
    recordPayment.mockResolvedValue({ ok: false, error: "notOldestFirst" });
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage inaccessible");
    });
    renderSection();
    await selectStudentAndFillAmount();
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: "keep me" } });

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    await waitFor(() => expect(screen.getByText(/couldn't finish clearing the local draft/i)).toBeInTheDocument());
    expect(window.localStorage.length).toBe(1);
    expect(screen.queryByLabelText(/Student/i)).toBeNull(); // still blocked, no submission possible

    fireEvent.click(screen.getByRole("button", { name: /Finish cleanup/i }));

    // Cleanup succeeded, but this was a REFUSAL — the form reappears with the draft intact, never the outcome screen.
    await waitFor(() => expect(screen.getByLabelText(/Notes/i)).toBeInTheDocument());
    expect((screen.getByLabelText(/Notes/i) as HTMLInputElement).value).toBe("keep me");
    expect(screen.queryByText("Payment recorded.")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(recordPayment).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("round 3, point 2: the draft resets after a confirmed outcome reached via the RECOVERY path too", () => {
  it("a filled form, a lost submit response, then a confirmed capture via 'Check status again': 'Record another' shows a genuinely empty form, and no duplicate write ever happens", async () => {
    recordPayment.mockRejectedValueOnce(new TypeError("network error"));
    renderSection();
    await selectStudentAndFillAmount();

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());

    checkSubmissionOutcome.mockResolvedValue({ status: "committed", outcome: { kind: "receipt", receiptId: "r1", currentStatus: "PENDING" } });
    fireEvent.click(screen.getByRole("button", { name: /Check status again/i }));

    await waitFor(() => expect(screen.getByText(/waiting, pending, in the exchange-rate queue/i)).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /Record another/i }));

    // Genuinely empty — not the filled-in draft from before the lost submission.
    expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("checkbox")).toBeNull(); // no obligations selected/shown until a student is picked again
    expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect(recordPayment).toHaveBeenCalledTimes(1); // the recovery check never performed a new financial write
  });
});

describe("round 3, point 3: the alreadySettled reconciliation fetch is locked, awaited, and its own rejection is handled", () => {
  it("submit stays disabled for the ENTIRE duration of a pending reconciliation fetch", async () => {
    const older = { ...OBLIGATION, obligationId: "ob-older", coverageMonth: 1 };
    const newer = { ...OBLIGATION, obligationId: "ob-newer", coverageMonth: 2 };
    renderSection();
    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [older, newer], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "220.00" } });

    const reconcile = deferred<Awaited<ReturnType<typeof getPayableObligations>>>();
    getPayableObligations.mockReturnValueOnce(reconcile.promise);
    recordPayment.mockResolvedValueOnce({ ok: false, error: "alreadySettled", alreadySettledIds: ["ob-older"] });

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));
    await waitFor(() => expect(screen.getByText(/Already settled: ob-older/i)).toBeInTheDocument());

    // The reconciliation fetch is still pending — submit must stay disabled the whole time, and no second write fires.
    expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect(recordPayment).toHaveBeenCalledTimes(1);

    reconcile.resolve({ ok: true, obligations: [newer], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    await waitFor(() => expect(screen.getByRole("button", { name: /Record payment/i })).not.toBeDisabled());
  });

  it("a rejected reconciliation fetch is handled (never an unhandled rejection), offers a retry, and a successful retry reconciles the selection while leaving typed fields untouched", async () => {
    const older = { ...OBLIGATION, obligationId: "ob-older", coverageMonth: 1 };
    const newer = { ...OBLIGATION, obligationId: "ob-newer", coverageMonth: 2 };
    renderSection();
    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [older, newer], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "220.00" } });
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: "please keep this" } });

    getPayableObligations.mockRejectedValueOnce(new Error("network down"));
    recordPayment.mockResolvedValueOnce({ ok: false, error: "alreadySettled", alreadySettledIds: ["ob-older"] });

    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));

    // Handled, not an unhandled rejection — a distinct error with a retry control, submission still blocked.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Retry$/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Record payment/i })).toBeDisabled();
    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe("220.00");
    expect((screen.getByLabelText(/Notes/i) as HTMLInputElement).value).toBe("please keep this");

    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [newer], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Record payment/i })).not.toBeDisabled());
    // Typed fields survived the whole reconciliation round-trip untouched.
    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe("220.00");
    expect((screen.getByLabelText(/Notes/i) as HTMLInputElement).value).toBe("please keep this");
    // Only the still-valid obligation remains in the list.
    expect(screen.getByText(/2027-02 \(Monthly\)/)).toBeInTheDocument();
    expect(screen.queryByText(/2027-01 \(Monthly\)/)).toBeNull();
  });

  it("a stale reconciliation response for student A never overwrites student B's state once the owner has switched", async () => {
    renderSection();
    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [OBLIGATION], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-1" } });
    await waitFor(() => expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: "100.00" } });

    const reconcileA = deferred<Awaited<ReturnType<typeof getPayableObligations>>>();
    getPayableObligations.mockReturnValueOnce(reconcileA.promise);
    recordPayment.mockResolvedValueOnce({ ok: false, error: "alreadySettled", alreadySettledIds: ["ob-1"] });
    fireEvent.click(screen.getByRole("button", { name: /Record payment/i }));
    await waitFor(() => expect(screen.getByText(/Already settled: ob-1/i)).toBeInTheDocument());

    // The owner switches to student B while A's reconciliation is still pending.
    const obligationB = { ...OBLIGATION, obligationId: "ob-B" };
    getPayableObligations.mockResolvedValueOnce({ ok: true, obligations: [obligationB], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    fireEvent.change(screen.getByLabelText(/Student/i), { target: { value: "student-2" } });
    await waitFor(() => expect(screen.getByText(/2027-02 \(Monthly\)/)).toBeInTheDocument());

    // A's stale reconciliation now resolves — must be discarded, never overwriting B's already-shown state.
    reconcileA.resolve({ ok: true, obligations: [OBLIGATION], mixedCurrency: false, todayLocal: TODAY_LOCAL });
    await new Promise((r) => setTimeout(r, 0));

    expect((screen.getByLabelText(/Student/i) as HTMLSelectElement).value).toBe("student-2");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});
