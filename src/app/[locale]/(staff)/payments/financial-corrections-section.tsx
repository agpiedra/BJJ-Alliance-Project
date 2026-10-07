"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import {
  correctLateFee,
  reversePaymentAction,
  waiveFee,
  getCorrectableLateFees,
  getReversiblePayments,
  getLateFeeStatus,
  getPaymentStatus,
} from "@/lib/dues/financial-corrections-actions";
import type { CorrectableLateFeeRow, ReversiblePaymentRow } from "@/lib/dues/financial-corrections-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Owner financial-corrections UI brief: late-fee correction, payment reversal, and late-fee waiver — three
 * ADMIN-only operations against existing records (never new purchases). §3 decision 3: ONE card, three clearly
 * separated flows; the fee-selection list is shared by correction and waiver, the payment-selection list is
 * reversal's own.
 *
 * STRUCTURALLY DIFFERENT RECOVERY MODEL from the three purchase cards (brief's own central finding, §1): every
 * target here (a `lateFeeId`/`paymentId`) is ALREADY a real, server-persisted id the owner selected from a list
 * BEFORE submitting anything — there is no client-generated submissionId, no `payment-attempt-storage.ts`
 * localStorage persistence, no `AttemptOperation` discriminator, no cross-card `useHasUnresolvedUnclassifiable`
 * integration. Recovery (brief §2.5/§3 decision 1) is the exact-target status-check pattern already proven live by
 * `ReceiptRow` (`awaiting-rate-receipt-list.tsx`) for `resolveAwaitingRateReceipt`/`cancelAwaitingRateReceipt` —
 * themselves also never wrapped by submission identity. A row's own draft (reason/tender/etc.) lives in plain React
 * state for the page's lifetime only: a reload loses an in-progress uncertain attempt's draft (unlike the three
 * purchase cards' own mount-time localStorage scan) — the owner can look the same record up again from the
 * selection list or a direct recovery lookup and see its real current state; nothing is silently lost, it is just
 * not auto-resumed across a reload. This is a deliberate scope choice, not an oversight.
 *
 * CORRECTION ROUND 2 (5 issues):
 * 1. Rows used to unmount on every refresh (parent gated the list on a single `loadStatus`, which a sibling row's
 *    own `onResolved()` flipped back through "loading") — destroying any OTHER row's typed draft or uncertain
 *    recovery state. Lists now render off `fees !== null`/`payments !== null` directly, never re-gated on
 *    `loadStatus`. (Round 3 below corrects how the refresh itself applies its own fresh data — stable keys alone
 *    were never enough.)
 * 2. "Amount received" no longer prefills from the late fee's own amount (a different, unrelated figure from what
 *    correction's settlement step actually requires as tender) — it starts blank. The obligation's own amount is
 *    shown as separate, clearly labeled reference context. Each operation shows its own explicit confirmation copy.
 * 3. Recovery-observed outcomes (reached via `getLateFeeStatus`/`getPaymentStatus` after an uncertain prior attempt)
 *    render DESCRIPTIVE copy only ("this fee is now shown as voided") — never the DIRECT-success copy ("this fee was
 *    voided and settled"), which is reserved for an outcome this exact request-response cycle actually produced.
 * 4. Both selection lists are now cursor-paginated ("Load older" per list) — a flat `take` cap alone made anything
 *    past the first page permanently unreachable. (Round 3 below adds request-safety to these cursor fetches.)
 * 5. `notOnTime` copy corrected (it had the refusal's own meaning backwards); `stale` now genuinely reconciles (a
 *    scoped re-fetch of the row's own fresh revision, never a silent resubmit under the old one); settlement-total
 *    refusals (`notASelectableTotal`/`totalMismatch`) render their own `selectableTotals` detail.
 *
 * CORRECTION ROUND 3 (3 issues — round 2's own point 1 above OVERCLAIMED what "overwrites in place" actually
 * preserved; corrected here):
 * 1. `refresh()` used to REPLACE `fees`/`payments` with page 1 of a fresh fetch. A stable `key={row.id}` only
 *    preserves a row's component instance for ids that are STILL in the new array — it does nothing for a row that
 *    the fresh array simply omits. Two real consequences: (a) any row loaded via "Load older" (now past page 1)
 *    vanished the instant a SIBLING row's refresh landed; (b) a row currently uncertain (awaiting its own recovery
 *    check) whose lost write had ACTUALLY succeeded — meaning the fresh candidate fetch correctly excludes it —
 *    would vanish mid-recovery, destroying the owner's own in-progress status check. `refresh()` now MERGES: a row
 *    currently tracked as blocking (`blockingIdsRef`, below) is frozen exactly as-is, never replaced or dropped; any
 *    other existing row is updated with fresh data if the fresh fetch still includes it, otherwise left exactly as
 *    it was (never silently truncated back to page 1); brand-new rows from the fresh fetch are prepended. Cursors
 *    are deliberately NOT touched by `refresh()` — pagination position is owned solely by `loadForStudent`/
 *    `loadMoreFees`/`loadMorePayments`.
 * 2. `loadMoreFees`/`loadMorePayments` had no request-safety at all: no discriminator (a stale response for a
 *    PREVIOUS student, or one that lands after an unrelated `refresh()`, could silently merge into whatever is
 *    CURRENTLY displayed) and no catch handler (a rejection just left the "Load older" button permanently inert,
 *    no error, no retry). Both now capture the shared `requestRef` generation before firing, discard an obsolete
 *    response outright (never applied), and show a dedicated "couldn't load more" error with its own retry on a
 *    genuine failure — the already-loaded rows are left untouched either way.
 * 3. The student-switch guard used to key off `uncertainRowsRef`, which was only ever populated AFTER a write's own
 *    result was known to be uncertain — a switch attempted WHILE a write was still in flight (`busy`, response not
 *    yet known) was never blocked or even warned about. It also used a dismissable `window.confirm(...)` rather
 *    than an actual block. Replaced with `blockingIdsRef`/`blockingCount`: every row reports itself blocking from
 *    the exact moment its own write begins (`setBusy(true)`) through either definitive completion (direct success,
 *    or an ordinary non-uncertain refusal) or recovery resolution — imperatively, at each exact transition, same
 *    discipline as round 2's own CI-caught `onUncertainChange` race fix (never derived via an effect watching
 *    `needsRefresh`, which is not guaranteed to flush before the next synchronous interaction). The student
 *    `<select>` itself is now `disabled` while `blockingCount > 0` — no confirm dialog, no abandon-uncertainty path.
 *
 * CORRECTION ROUND 4 (2 issues):
 * 1. `reconcileStale` (the ONE write/recovery path round 3 missed) never reported itself blocking — a student switch
 *    attempted while a `stale` reconciliation was in flight was never prevented. Its late-resolving `onResolved`
 *    call then ran inside a STALE `handleRowResolved`/`refresh` closure pair (captured from the render where the OLD
 *    student was still selected), merging the old student's own records into whatever the NEW student's lists had
 *    since become. Fixed in three layers: (a) `reconcileStale` now reports blocking from its own start, same
 *    discipline as every other path; (b) it also gained `mountedRef`-guarded cancellation (it has no `useEffect` of
 *    its own to lean on, unlike the `needsRefresh` recovery effect, which already tracked a local `cancelled` flag);
 *    (c) `handleRowResolved` itself now takes the student id the resolving row was rendered under and compares it
 *    against `selectedStudentIdRef.current` (a `ref` — the SAME mutable object across every render, so even a STALE
 *    closure reads the REAL current value) — a mismatch is silently ignored. Layer (c) is the actual structural
 *    fix: it makes the cross-student merge impossible regardless of whether some future path reintroduces a gap
 *    like (a)'s own.
 * 2. `setConfirmedState(...)` followed immediately by `onResolved(id, true)` removed the resolving row from its list
 *    in the SAME render cycle the confirmation was meant to paint in — the owner never actually saw "this fee was
 *    voided and settled" before the row vanished. The outcome now also travels to the PARENT as `recentOutcomes`
 *    (appended, never overwritten, so several resolutions each keep their own line), rendered OUTSIDE the
 *    removed row, student-scoped (cleared on a student switch), surviving `refresh()` untouched. Reuses the exact
 *    same direct-vs-observed, VOIDED-vs-WAIVED translation keys already established — only WHERE they render moved.
 */

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every refusal code across all three writers (brief §2.4/§2.6's own tables) maps to its own distinct copy key —
 * never a shared fallback for two different causes. Codes absent here fall through to a generic `t("error.unexpected")`.
 * Correction round 2: added the settlement-total codes (`notASelectableTotal`/`totalMismatch`/`ambiguousTotal`) that
 * were previously falling through to the generic "unexpected" copy. */
const ERROR_KEY: Record<string, string> = {
  notActive: "notActive",
  invalid: "invalid",
  notFound: "notFound",
  stale: "stale",
  alreadyRemoved: "alreadyRemoved",
  notOnTime: "notOnTime",
  alreadyPaid: "alreadyPaid",
  alreadyReversed: "alreadyReversed",
  unsupportedObligationType: "unsupportedObligationType",
  voidedFeeBlocksReversal: "voidedFeeBlocksReversal",
  prepaymentBlocksReversal: "prepaymentBlocksReversal",
  inconsistentState: "unexpected",
  notOldestFirst: "notOldestFirst",
  rateUnavailable: "rateUnavailable",
  alreadySettled: "alreadySettled",
  futureDate: "futureDate",
  tooOld: "tooOld",
  currencyMismatch: "currencyMismatch",
  notASelectableTotal: "notASelectableTotal",
  totalMismatch: "totalMismatch",
  ambiguousTotal: "ambiguousTotal",
};
function errorMessageKey(code: string): string {
  return ERROR_KEY[code] ?? "unexpected";
}

/** Correction round 3, issue 1: merges a fresh page-1 fetch into the existing array rather than replacing it. A row
 * currently blocking (busy mid-write, or awaiting its own recovery check) is frozen exactly as-is — never replaced,
 * never dropped, even if the fresh fetch no longer includes it (that can mean its own lost write actually
 * succeeded; its own recovery check, not a sibling's refresh, is what gets to decide its fate). Any other existing
 * row is updated with fresh data if still present in the fetch, otherwise left untouched (never truncated back to
 * page 1 just because a page-1-only refresh doesn't re-confirm it). Brand-new rows are prepended. */
function mergePage<T extends { id: string }>(existing: T[], fresh: T[], blockingIds: Set<string>): T[] {
  const freshById = new Map(fresh.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const merged = existing.map((row) => {
    seen.add(row.id);
    if (blockingIds.has(row.id)) return row;
    return freshById.get(row.id) ?? row;
  });
  const newRows = fresh.filter((row) => !seen.has(row.id));
  return [...newRows, ...merged];
}

/** A refusal carrying `selectableTotals` — the subset of `CorrectLateFeeResult`'s own `{ok:false}` shape this
 * component actually reads. Both settlement-total codes above populate it (`record-payment.ts`); nothing else does. */
type RowError = { code: string; selectableTotals?: string[] };

/** Correction round 4, issue 2: what a resolved row tells the parent about ITS OWN outcome, so the parent can render
 * the exact same already-established copy (direct vs. recovery-observed, VOIDED vs. WAIVED) as persistent,
 * student-scoped feedback AFTER the row itself has been removed from the list — never recomputed, just relocated. */
type RowOutcome =
  | { kind: "fee"; removalKind: "VOIDED" | "WAIVED"; source: "direct" | "recovery" }
  | { kind: "payment"; source: "direct" | "recovery" };

/** One entry in the parent's own `recentOutcomes` list — `rowId` keys it for React, everything else is `RowOutcome`
 * verbatim. */
type RecentOutcome = { rowId: string } & RowOutcome;

export function FinancialCorrectionsSection({ organizationId, students }: { organizationId: string; students: Student[] }) {
  const t = useTranslations("payments.financialCorrections");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [fees, setFees] = useState<CorrectableLateFeeRow[] | null>(null);
  const [payments, setPayments] = useState<ReversiblePaymentRow[] | null>(null);
  const [feesCursor, setFeesCursor] = useState<string | null>(null);
  const [paymentsCursor, setPaymentsCursor] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [loadingMoreFees, setLoadingMoreFees] = useState(false);
  const [loadingMorePayments, setLoadingMorePayments] = useState(false);
  const [loadMoreFeesError, setLoadMoreFeesError] = useState(false);
  const [loadMorePaymentsError, setLoadMorePaymentsError] = useState(false);
  const requestRef = useRef(0);
  // Correction round 3, issue 3: which currently-mounted row ids are "blocking" right now — busy mid-write OR
  // awaiting their own recovery resolution. A ref for `mergePage`'s own synchronous read during a refresh, PLUS a
  // mirrored count in state so the student `<select>` can reactively disable itself (a ref change alone never
  // triggers a re-render). Each row reports its own transitions via `reportBlocking`, imperatively, same discipline
  // as every other state-transition report in this file (never derived via an effect).
  const blockingIdsRef = useRef<Set<string>>(new Set());
  const [blockingCount, setBlockingCount] = useState(0);
  // Correction round 4, issue 1: the CURRENT student, readable from inside a STALE closure. `selectedStudentId`
  // itself is only correct from the render that captured it — a row's own async callback (e.g. `reconcileStale`)
  // may still be holding a reference to an OLD `handleRowResolved`/`refresh` pair from a render where this was a
  // DIFFERENT student. A `ref` is the same mutable object across every render, so reading `.current` from inside
  // even a stale closure always sees the live value. Kept in sync in the ONE place `selectedStudentId` ever
  // changes (`handleStudentChange`), not via an effect — no render-cycle lag.
  const selectedStudentIdRef = useRef(selectedStudentId);
  // Correction round 4, issue 2: persistent, student-scoped feedback for a row's own outcome — rendered OUTSIDE the
  // row (which `handleRowResolved` removes from `fees`/`payments` in the same tick a direct success/observed-removal
  // sets its own `confirmedState`, so the row's own in-row message never actually paints before it unmounts).
  const [recentOutcomes, setRecentOutcomes] = useState<RecentOutcome[]>([]);

  function reportBlocking(id: string, blocking: boolean) {
    const had = blockingIdsRef.current.has(id);
    if (blocking === had) return;
    if (blocking) blockingIdsRef.current.add(id);
    else blockingIdsRef.current.delete(id);
    setBlockingCount(blockingIdsRef.current.size);
  }

  /** The student-level load: resets everything and fetches page 1 of both lists. Only this path nulls `fees`/
   * `payments` — a background refresh (see `refresh` below) never does, so rows stay mounted through it. */
  function loadForStudent(studentId: string) {
    if (!studentId) return;
    const requestId = ++requestRef.current;
    setLoadStatus("loading");
    Promise.all([getCorrectableLateFees(organizationId, studentId), getReversiblePayments(organizationId, studentId)])
      .then(([feePage, paymentPage]) => {
        if (requestRef.current !== requestId) return;
        setFees(feePage.rows);
        setFeesCursor(feePage.nextCursor);
        setPayments(paymentPage.rows);
        setPaymentsCursor(paymentPage.nextCursor);
        setLoadStatus("loaded");
      })
      .catch(() => {
        if (requestRef.current !== requestId) return;
        setLoadStatus("failed");
      });
  }

  /** Correction round 3, issue 1: a BACKGROUND refresh — re-fetches page 1 of both lists and MERGES it into the
   * existing arrays (`mergePage`, above), never replaces them and never touches `loadStatus`. A blocking row (busy
   * or awaiting recovery) is frozen; any other row is updated if still present, otherwise left as-is — nothing
   * beyond page 1 is silently dropped just because this is a page-1-only fetch. Cursors are deliberately untouched
   * here (see the file's own top doc comment). */
  function refresh() {
    if (!selectedStudentId) return;
    const requestId = ++requestRef.current;
    Promise.all([getCorrectableLateFees(organizationId, selectedStudentId), getReversiblePayments(organizationId, selectedStudentId)])
      .then(([feePage, paymentPage]) => {
        if (requestRef.current !== requestId) return;
        setFees((prev) => (prev === null ? feePage.rows : mergePage(prev, feePage.rows, blockingIdsRef.current)));
        setPayments((prev) => (prev === null ? paymentPage.rows : mergePage(prev, paymentPage.rows, blockingIdsRef.current)));
      })
      .catch(() => {
        // A background refresh that fails just leaves the existing (possibly slightly stale) lists displayed —
        // never destructive. The next successful refresh (another row resolving, or a manual retry) corrects it.
      });
  }

  /** Correction round 3, issue 2: shares `requestRef`'s own generation counter with `loadForStudent`/`refresh` — a
   * response that lands after the student changed, or after an unrelated refresh fired, is discarded outright,
   * never merged into whatever is currently displayed. A genuine failure never mutates the already-loaded rows;
   * it only surfaces a dedicated error with its own retry (the same `feesCursor` still points at the right spot). */
  async function loadMoreFees() {
    if (!feesCursor || loadingMoreFees) return;
    const requestId = requestRef.current;
    setLoadingMoreFees(true);
    setLoadMoreFeesError(false);
    try {
      const page = await getCorrectableLateFees(organizationId, selectedStudentId, feesCursor);
      if (requestRef.current !== requestId) return;
      setFees((prev) => {
        const seen = new Set((prev ?? []).map((f) => f.id));
        return [...(prev ?? []), ...page.rows.filter((f) => !seen.has(f.id))];
      });
      setFeesCursor(page.nextCursor);
    } catch {
      if (requestRef.current !== requestId) return;
      setLoadMoreFeesError(true);
    } finally {
      setLoadingMoreFees(false);
    }
  }

  /** `loadMoreFees`'s own exact counterpart for payments. */
  async function loadMorePayments() {
    if (!paymentsCursor || loadingMorePayments) return;
    const requestId = requestRef.current;
    setLoadingMorePayments(true);
    setLoadMorePaymentsError(false);
    try {
      const page = await getReversiblePayments(organizationId, selectedStudentId, paymentsCursor);
      if (requestRef.current !== requestId) return;
      setPayments((prev) => {
        const seen = new Set((prev ?? []).map((p) => p.id));
        return [...(prev ?? []), ...page.rows.filter((p) => !seen.has(p.id))];
      });
      setPaymentsCursor(page.nextCursor);
    } catch {
      if (requestRef.current !== requestId) return;
      setLoadMorePaymentsError(true);
    } finally {
      setLoadingMorePayments(false);
    }
  }

  /** Correction round 3, issue 3: a hard block, not a dismissable confirm — `blockingCount` already disables the
   * `<select>` itself; this is defense-in-depth against a change event that somehow still fires. */
  function handleStudentChange(next: string) {
    if (blockingIdsRef.current.size > 0) return;
    selectedStudentIdRef.current = next; // synchronous — see the ref's own doc comment above
    setSelectedStudentId(next);
  }

  useEffect(() => {
    setFees(null);
    setPayments(null);
    setFeesCursor(null);
    setPaymentsCursor(null);
    setLoadStatus("idle");
    setLoadingMoreFees(false);
    setLoadingMorePayments(false);
    setLoadMoreFeesError(false);
    setLoadMorePaymentsError(false);
    setRecentOutcomes([]); // correction round 4, issue 2: student-scoped — never carries over to a different student
    if (selectedStudentId) loadForStudent(selectedStudentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fires only on an actual student change
  }, [selectedStudentId]);

  /** A row's own successful write (or discovered already-finalized state) means the lists may be stale.
   * `removed=true` (a direct void/waive/reversal, or the same discovered via recovery) is handled EXPLICITLY and
   * synchronously here — no need to wait for or infer anything from a fresh fetch, and `refresh()`'s own merge never
   * drops a row by design (that's precisely what used to destroy sibling state, correction round 3's own fix) so
   * nothing else would ever remove it otherwise. `removed=false` (e.g. `alreadySettled` — this row's own operation
   * did NOT commit, something else just changed) only triggers the background reconciliation below.
   *
   * Correction round 4, issue 1: `forStudentId` is the student THIS ROW was rendered under (captured at its own
   * render time, passed back verbatim) — compared against `selectedStudentIdRef.current` (the REAL current student,
   * readable even from inside a stale closure). A mismatch means this callback is obsolete — the owner switched
   * students after this row fired its own request but before the response landed — and is silently ignored: there
   * is nothing in the CURRENT view that corresponds to a different student's row, no refresh, no removal.
   *
   * Correction round 4, issue 2: `outcome` (present only when `removed` is true) is what actually happened, in the
   * exact shape the parent-level `recentOutcomes` feedback needs — appended, never replacing a prior entry, so
   * several consecutive resolutions each keep their own visible confirmation. */
  function handleRowResolved(id: string, removed: boolean, forStudentId: string | undefined, outcome?: RowOutcome) {
    if (forStudentId !== selectedStudentIdRef.current) return;
    if (removed) {
      setFees((prev) => (prev ? prev.filter((f) => f.id !== id) : prev));
      setPayments((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
      if (outcome) setRecentOutcomes((prev) => [...prev, { rowId: id, ...outcome }]);
    }
    refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("fields.student")}</span>
        <select disabled={blockingCount > 0} value={selectedStudentId} onChange={(e) => handleStudentChange(e.target.value)} className={FIELD_CLASS}>
          <option value="">{t("fields.studentPlaceholder")}</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.firstName} {s.lastName} — {s.academyName}
            </option>
          ))}
        </select>
      </label>

      {selectedStudentId && loadStatus === "loading" && fees === null && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {selectedStudentId && loadStatus === "failed" && fees === null && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">
            {t("loadFailed")}
          </p>
          <Button type="button" variant="outline" onClick={() => loadForStudent(selectedStudentId)}>
            {t("retry")}
          </Button>
        </div>
      )}

      {/* Correction round 4, issue 2: persistent, student-scoped outcome feedback — survives the resolved row's own
          removal. Reuses the exact same translation keys the row itself used to render inline, just relocated. */}
      {recentOutcomes.length > 0 && (
        <div className="flex flex-col gap-1">
          {recentOutcomes.map((o) => (
            <p key={o.rowId} role="status" className="text-sm text-ok">
              {o.kind === "fee" && o.removalKind === "VOIDED" && t(o.source === "direct" ? "fee.outcome.voidedDirect" : "fee.outcome.voidedObserved")}
              {o.kind === "fee" && o.removalKind === "WAIVED" && t(o.source === "direct" ? "fee.outcome.waivedDirect" : "fee.outcome.waivedObserved")}
              {o.kind === "payment" && t(o.source === "direct" ? "payment.outcome.reversedDirect" : "payment.outcome.reversedObserved")}
            </p>
          ))}
        </div>
      )}

      {selectedStudentId && fees !== null && payments !== null && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("fees.heading")}</p>
            {fees.length === 0 && <p className="text-sm text-muted-foreground">{t("fees.none")}</p>}
            {fees.length > 0 && (
              <ul className="flex flex-col gap-3">
                {fees.map((fee) => (
                  <LateFeeRow key={fee.id} organizationId={organizationId} studentId={selectedStudentId} fee={fee} onResolved={handleRowResolved} onBlockingChange={reportBlocking} />
                ))}
              </ul>
            )}
            {feesCursor && !loadMoreFeesError && (
              <div>
                <Button type="button" variant="outline" disabled={loadingMoreFees} onClick={loadMoreFees}>
                  {loadingMoreFees ? t("loadingMore") : t("loadOlder")}
                </Button>
              </div>
            )}
            {loadMoreFeesError && (
              <div className="flex items-center gap-2">
                <p role="alert" className="text-sm text-bad">{t("loadMoreFailed")}</p>
                <Button type="button" variant="outline" onClick={loadMoreFees}>{t("retry")}</Button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("payments.heading")}</p>
            {payments.length === 0 && <p className="text-sm text-muted-foreground">{t("payments.none")}</p>}
            {payments.length > 0 && (
              <ul className="flex flex-col gap-3">
                {payments.map((payment) => (
                  <PaymentRow key={payment.id} organizationId={organizationId} studentId={selectedStudentId} payment={payment} onResolved={handleRowResolved} onBlockingChange={reportBlocking} />
                ))}
              </ul>
            )}
            {paymentsCursor && !loadMorePaymentsError && (
              <div>
                <Button type="button" variant="outline" disabled={loadingMorePayments} onClick={loadMorePayments}>
                  {loadingMorePayments ? t("loadingMore") : t("loadOlder")}
                </Button>
              </div>
            )}
            {loadMorePaymentsError && (
              <div className="flex items-center gap-2">
                <p role="alert" className="text-sm text-bad">{t("loadMoreFailed")}</p>
                <Button type="button" variant="outline" onClick={loadMorePayments}>{t("retry")}</Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type RecoveryState = {
  needsRefresh: boolean;
  refreshStatus: "idle" | "loading" | "failed";
  refreshNonce: number;
};

const IDLE_RECOVERY: RecoveryState = { needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 };

/** Correction round 2, issue 3: which copy a finalized/observed state renders — `"direct"` (this exact
 * request-response cycle produced the outcome, genuinely attributable to this attempt) vs `"recovery"` (reached via
 * an exact-target status re-read after an earlier, uncertain attempt — descriptive only, never attributed). */
type ConfirmedState = { kind: "removed"; removalKind: "VOIDED" | "WAIVED"; source: "direct" | "recovery" } | { kind: "unchanged" } | null;

/** Exported for direct testing — mirrors `ReceiptRow`'s own exact recovery shape (brief §2.5's directly reusable
 * precedent), applied to a late fee's own two operations (correct, waive). */
export function LateFeeRow({
  organizationId,
  studentId,
  fee,
  onResolved,
  onBlockingChange,
}: {
  organizationId: string;
  /** Correction round 4, issue 1: the student this row was rendered under — captured at render time, passed back
   * verbatim with every `onResolved` call so the parent can detect and ignore an obsolete callback (one firing after
   * the owner has since switched to a different student). Optional for standalone row tests that don't care. */
  studentId?: string;
  fee: CorrectableLateFeeRow;
  /** Correction round 3, issue 1: reports this row's own id and whether it was genuinely removed (voided/waived),
   * so the parent can drop it explicitly rather than inferring removal from a sibling's own background refresh
   * (which never drops a row itself, by design — see `refresh()`'s own doc comment). `removed=false` for a
   * discovered-but-not-this-row's-doing change (e.g. `alreadySettled`) — only a background reconcile is warranted.
   * Correction round 4: `forStudentId` is this row's own `studentId` prop, echoed back (see that prop's own doc
   * comment); `outcome` (present only when `removed` is true) is what the parent's persistent feedback needs to
   * render the right copy after this row is gone (round 4, issue 2). */
  onResolved: (id: string, removed: boolean, forStudentId: string | undefined, outcome?: RowOutcome) => void;
  /** Correction round 3, issue 3: reports this row's own blocking/not-blocking transitions to the parent — blocking
   * from the moment a write begins through either definitive completion or recovery resolution — so the parent can
   * disable the student selector and `refresh()` can freeze this row instead of dropping it. Optional — standalone
   * row tests never need to wire it. */
  onBlockingChange?: (id: string, blocking: boolean) => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [mode, setMode] = useState<"idle" | "correcting" | "waiving">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RowError | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<ConfirmedState>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);
  // Correction round 2, issue 5: `stale` is NOT folded into the `needsRefresh`/recovery machinery above — that
  // machinery means "we don't know if an earlier attempt took effect." A `stale` refusal is the opposite: the
  // writer cleanly told us the view was outdated; nothing is uncertain, there is just a fresher revision to fetch.
  const [reconcilingStale, setReconcilingStale] = useState(false);
  // Correction round 2, issue 5: the revision actually used on the next submit — starts at the row's own prop, and
  // is updated in place once a `stale` reconcile fetches a fresher one. Never the prop directly after that point.
  const [currentRevision, setCurrentRevision] = useState(fee.expectedRevision);

  // Correction-only fields
  const [reason, setReason] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  // Correction round 2, issue 2: starts BLANK — never prefilled from `fee.amount` (the late fee itself, not the
  // amount correction's own settlement step actually requires as tender). The owner must type what was received.
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(fee.currency as Currency);
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const needsRefresh = transportFailure || error?.code === "alreadyRemoved";

  // Correction round 2, issue 1 (CI-caught race, fixed): reporting this transition via a `useEffect` watching
  // `needsRefresh` is NOT guaranteed to have flushed before the very next synchronous test/user interaction (a
  // `useEffect` runs in React's own passive-effect phase, a tick after the triggering commit is visible) — this
  // raced and failed intermittently in CI. `onBlockingChange` is now called IMPERATIVELY at each exact mutation
  // point below, in the same synchronous handler/callback that sets the underlying state — never derived.
  // onBlockingChange is a fresh inline function every parent render; only fee.id identity should re-arm this cleanup.
  //
  // Correction round 4, issue 1: `mountedRef` added to the SAME cleanup — `reconcileStale` (below) is a plain async
  // function with no `useEffect` of its own to lean on for cancellation (unlike the `needsRefresh` effect, which
  // already tracks its own local `cancelled` flag). If this row unmounts while `reconcileStale`'s own `await` is
  // still pending, its late resolution must not call `setState`/`onResolved` on a component that's gone.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onBlockingChange?.(fee.id, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onBlockingChange is a fresh inline function every parent render; only fee.id identity should re-arm this cleanup
  }, [fee.id]); // unmount-only safety net

  useEffect(() => {
    if (!needsRefresh) return;
    let cancelled = false;
    setRecovery((r) => ({ ...r, refreshStatus: "loading" }));
    getLateFeeStatus(organizationId, fee.id)
      .then((current) => {
        if (cancelled) return;
        if (!current) {
          setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
          return;
        }
        setRecovery({ needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 });
        if (current.removedAt === null) {
          // The earlier attempt does not appear to have taken effect YET — a fresh read is a snapshot, not proof
          // the in-flight request has actually finished resolving. Never auto-resubmitted, just unlocked for an
          // explicit, owner-initiated retry.
          setTransportFailure(false);
          setError(null);
          setCurrentRevision(current.expectedRevision);
          setConfirmedState({ kind: "unchanged" });
          onBlockingChange?.(fee.id, false); // imperative — see the mount-effect's own doc comment above
        } else {
          setConfirmedState({ kind: "removed", removalKind: current.removalKind!, source: "recovery" });
          onBlockingChange?.(fee.id, false);
          onResolved(fee.id, true, studentId, { kind: "fee", removalKind: current.removalKind!, source: "recovery" });
        }
      })
      .catch(() => {
        if (!cancelled) setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on a fresh needsRefresh or an explicit retry nonce
  }, [needsRefresh, recovery.refreshNonce]);

  /** Correction round 2, issue 5: the promised "stale → safe refresh" reconciliation, actually implemented — an
   * explicit, owner-initiated re-fetch of THIS fee's own current revision (never automatic). Draft fields
   * (reason/amount/etc.) and `mode` are untouched; only `currentRevision` and `error` change. If the fee turns out
   * to have been removed by someone else in the meantime, that's reported the same way `alreadyRemoved` already is.
   *
   * Correction round 4, issue 1: this used to be the ONE write/recovery path in the file that never reported itself
   * blocking — a student switch attempted while this `await` was still pending was never prevented. Now reports
   * blocking at the exact start (imperative, same discipline as every other path) and clears it on every exit.
   * `mountedRef` guards every `setState`/`onResolved` call against a late resolution firing after this row has
   * already unmounted (e.g. a future path that unmounts it some other way) — defense-in-depth alongside the
   * blocking report and the parent's own `forStudentId` check in `handleRowResolved`. */
  async function reconcileStale() {
    setReconcilingStale(true);
    onBlockingChange?.(fee.id, true);
    try {
      const current = await getLateFeeStatus(organizationId, fee.id);
      if (!mountedRef.current) return;
      if (!current) {
        setError({ code: "notFound" });
        return;
      }
      if (current.removedAt === null) {
        setCurrentRevision(current.expectedRevision);
        setError(null);
      } else {
        setConfirmedState({ kind: "removed", removalKind: current.removalKind!, source: "recovery" });
        onResolved(fee.id, true, studentId, { kind: "fee", removalKind: current.removalKind!, source: "recovery" });
      }
    } catch {
      // Reconcile itself failed — leave the stale error exactly as shown; the same button remains to retry it.
    } finally {
      onBlockingChange?.(fee.id, false);
      if (mountedRef.current) setReconcilingStale(false);
    }
  }

  async function handleCorrect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // Correction round 3, issue 3: blocking from the exact moment the write starts, same tick as `setBusy(true)` —
    // imperative, never derived. Cleared below on every path EXCEPT `alreadyRemoved`/a thrown rejection, both of
    // which hand off to the recovery flow, which clears it once IT resolves.
    onBlockingChange?.(fee.id, true);
    try {
      const fd = new FormData();
      fd.set("lateFeeId", fee.id);
      fd.set("expectedRevision", currentRevision);
      fd.set("removalReason", reason);
      fd.set("receivedOn", receivedOn);
      fd.set("tenderCurrency", currency);
      fd.set("tenderAmount", amount);
      fd.set("method", method);
      if (notes.trim()) fd.set("notes", notes);
      const result = await correctLateFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "VOIDED", source: "direct" });
        onBlockingChange?.(fee.id, false);
        onResolved(fee.id, true, studentId, { kind: "fee", removalKind: "VOIDED", source: "direct" });
      } else {
        setError({ code: result.error, selectableTotals: "selectableTotals" in result ? result.selectableTotals : undefined });
        // alreadySettled: the obligation this fee was blocking is now settled some other way — the correction never
        // committed (the whole transaction, including the provisional void, rolled back) — THIS fee is NOT removed,
        // but something else changed, so a background reconcile is still warranted.
        if (result.error === "alreadySettled") onResolved(fee.id, false, studentId);
        // alreadyRemoved is the one refusal here that enters the needsRefresh/recovery flow — stays blocking (its
        // own recovery resolution clears it); every OTHER refusal is definitive and known right now, so it's safe
        // to unblock immediately.
        if (result.error !== "alreadyRemoved") onBlockingChange?.(fee.id, false);
      }
    } catch {
      setTransportFailure(true);
      // Stays blocking — already true from the top of this function; the recovery flow clears it once it resolves.
    } finally {
      setBusy(false);
    }
  }

  async function handleWaive(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onBlockingChange?.(fee.id, true);
    try {
      const fd = new FormData();
      fd.set("lateFeeId", fee.id);
      fd.set("expectedRevision", currentRevision);
      fd.set("removalReason", reason);
      const result = await waiveFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "WAIVED", source: "direct" });
        onBlockingChange?.(fee.id, false);
        onResolved(fee.id, true, studentId, { kind: "fee", removalKind: "WAIVED", source: "direct" });
      } else {
        setError({ code: result.error });
        if (result.error !== "alreadyRemoved") onBlockingChange?.(fee.id, false);
      }
    } catch {
      setTransportFailure(true);
    } finally {
      setBusy(false);
    }
  }

  const finalized = confirmedState?.kind === "removed";
  const disabled = busy || needsRefresh || reconcilingStale;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {fee.coverageYear}-{String(fee.coverageMonth).padStart(2, "0")}
        </span>
        <span>{t("fee.feeAmountLabel", { amount: fee.amount, currency: fee.currency })}</span>
      </div>
      {/* Correction round 2, issue 2: reference-only context, clearly labeled and visually distinct from the fee
          amount above — never wired as any field's default value. */}
      <p className="text-xs text-muted-foreground">{t("fee.obligationAmountLabel", { amount: fee.obligationAmount, currency: fee.currency })}</p>

      {finalized && confirmedState.removalKind === "VOIDED" && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "fee.outcome.voidedDirect" : "fee.outcome.voidedObserved")}
        </p>
      )}
      {finalized && confirmedState.removalKind === "WAIVED" && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "fee.outcome.waivedDirect" : "fee.outcome.waivedObserved")}
        </p>
      )}
      {confirmedState?.kind === "unchanged" && <p className="text-xs text-muted-foreground">{t("recovery.unchanged")}</p>}

      {needsRefresh && recovery.refreshStatus === "idle" && (
        <p role="alert" className="text-sm text-bad">{t("recovery.transportFailure")}</p>
      )}
      {recovery.refreshStatus === "loading" && <p className="text-sm text-muted-foreground">{t("recovery.checking")}</p>}
      {recovery.refreshStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("recovery.checkFailed")}</p>
          <Button type="button" variant="outline" onClick={() => setRecovery((r) => ({ ...r, refreshNonce: r.refreshNonce + 1 }))}>
            {t("recovery.checkAgain")}
          </Button>
        </div>
      )}

      {error && !needsRefresh && error.code === "stale" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("error.stale")}</p>
          <Button type="button" variant="outline" disabled={reconcilingStale} onClick={reconcileStale}>
            {reconcilingStale ? t("recovery.checking") : t("fee.reconcileRevision")}
          </Button>
        </div>
      )}
      {error && !needsRefresh && error.code !== "stale" && (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error.code)}`)}</p>
          {error.code === "notOldestFirst" && <p className="text-xs text-muted-foreground">{t("fee.olderDebt")}</p>}
          {error.selectableTotals && error.selectableTotals.length > 0 && (
            <p className="text-xs text-muted-foreground">{t("error.selectableTotalsDetail", { totals: error.selectableTotals.join(", ") })}</p>
          )}
        </div>
      )}

      {!finalized && (
        <div className="flex gap-2">
          <Button type="button" variant={mode === "correcting" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "correcting" ? "idle" : "correcting")}>
            {t("fee.correctAction")}
          </Button>
          <Button type="button" variant={mode === "waiving" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "waiving" ? "idle" : "waiving")}>
            {t("fee.waiveAction")}
          </Button>
        </div>
      )}

      {!finalized && mode === "correcting" && (
        <form onSubmit={handleCorrect} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("fee.correctConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.receivedOn")}</span>
              <Input type="date" required disabled={disabled} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.amount")}</span>
              <Input type="text" inputMode="decimal" required disabled={disabled} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.currency")}</span>
              <select className={FIELD_CLASS} disabled={disabled} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.method")}</span>
              <select className={FIELD_CLASS} disabled={disabled} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.notes")}</span>
            <Input type="text" maxLength={500} disabled={disabled} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("fee.correctSubmit")}</Button>
          </div>
        </form>
      )}

      {!finalized && mode === "waiving" && (
        <form onSubmit={handleWaive} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("fee.waiveConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("fee.waiveSubmit")}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

type PaymentConfirmedState = { kind: "reversed"; source: "direct" | "recovery" } | { kind: "unchanged" } | null;

/** Exported for direct testing — the reversal flow's own row, mirroring `LateFeeRow`'s recovery shape. Every row
 * stays visible regardless of restriction (brief §3 decision 4); a restricted row's own reversal action is disabled,
 * with a specific named explanation, never hidden. */
export function PaymentRow({
  organizationId,
  studentId,
  payment,
  onResolved,
  onBlockingChange,
}: {
  organizationId: string;
  /** Correction round 4, issue 1 — `LateFeeRow`'s own exact counterpart. */
  studentId?: string;
  payment: ReversiblePaymentRow;
  /** Correction round 3, issue 1 — `LateFeeRow`'s own exact counterpart. Correction round 4 — same `forStudentId`/
   * `outcome` extension. */
  onResolved: (id: string, removed: boolean, forStudentId: string | undefined, outcome?: RowOutcome) => void;
  onBlockingChange?: (id: string, blocking: boolean) => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RowError | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<PaymentConfirmedState>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);
  const [reason, setReason] = useState("");

  const needsRefresh = transportFailure || error?.code === "alreadyReversed";

  // Correction round 2, issue 1 (CI-caught race, fixed) — same reasoning as `LateFeeRow`'s own identical comment:
  // reported imperatively at each exact mutation point below, never derived via a `useEffect` watching `needsRefresh`.
  // Same reasoning as LateFeeRow's own identical comment above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onBlockingChange?.(payment.id, false), [payment.id]); // unmount-only safety net

  useEffect(() => {
    if (!needsRefresh) return;
    let cancelled = false;
    setRecovery((r) => ({ ...r, refreshStatus: "loading" }));
    getPaymentStatus(organizationId, payment.id)
      .then((current) => {
        if (cancelled) return;
        if (!current) {
          setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
          return;
        }
        setRecovery({ needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 });
        if (current.reversedAt === null) {
          setTransportFailure(false);
          setError(null);
          setConfirmedState({ kind: "unchanged" });
          onBlockingChange?.(payment.id, false);
        } else {
          setConfirmedState({ kind: "reversed", source: "recovery" });
          onBlockingChange?.(payment.id, false);
          onResolved(payment.id, true, studentId, { kind: "payment", source: "recovery" });
        }
      })
      .catch(() => {
        if (!cancelled) setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on a fresh needsRefresh or an explicit retry nonce
  }, [needsRefresh, recovery.refreshNonce]);

  async function handleReverse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onBlockingChange?.(payment.id, true);
    try {
      const fd = new FormData();
      fd.set("paymentId", payment.id);
      fd.set("reversalReason", reason);
      const result = await reversePaymentAction(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "reversed", source: "direct" });
        onBlockingChange?.(payment.id, false);
        onResolved(payment.id, true, studentId, { kind: "payment", source: "direct" });
      } else {
        setError({ code: result.error });
        if (result.error !== "alreadyReversed") onBlockingChange?.(payment.id, false);
      }
    } catch {
      setTransportFailure(true);
    } finally {
      setBusy(false);
    }
  }

  const finalized = confirmedState?.kind === "reversed";
  const disabled = busy || needsRefresh;
  const restricted = payment.restrictions.hasUnsupportedObligationType || payment.restrictions.hasPrepaymentOrigin || payment.restrictions.hasVoidedFee;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{payment.receivedOn.year}-{String(payment.receivedOn.month).padStart(2, "0")}-{String(payment.receivedOn.day).padStart(2, "0")}</span>
        <span>{payment.tenderAmount} {payment.tenderCurrency}</span>
      </div>

      {finalized && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "payment.outcome.reversedDirect" : "payment.outcome.reversedObserved")}
        </p>
      )}
      {confirmedState?.kind === "unchanged" && <p className="text-xs text-muted-foreground">{t("recovery.unchanged")}</p>}

      {restricted && !finalized && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {payment.restrictions.hasUnsupportedObligationType && <p>{t("payment.restriction.unsupportedObligationType")}</p>}
          {payment.restrictions.hasPrepaymentOrigin && <p>{t("payment.restriction.prepaymentOrigin")}</p>}
          {payment.restrictions.hasVoidedFee && <p>{t("payment.restriction.voidedFee")}</p>}
        </div>
      )}

      {needsRefresh && recovery.refreshStatus === "idle" && (
        <p role="alert" className="text-sm text-bad">{t("recovery.transportFailure")}</p>
      )}
      {recovery.refreshStatus === "loading" && <p className="text-sm text-muted-foreground">{t("recovery.checking")}</p>}
      {recovery.refreshStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("recovery.checkFailed")}</p>
          <Button type="button" variant="outline" onClick={() => setRecovery((r) => ({ ...r, refreshNonce: r.refreshNonce + 1 }))}>
            {t("recovery.checkAgain")}
          </Button>
        </div>
      )}

      {error && !needsRefresh && <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error.code)}`)}</p>}

      {!finalized && !open && (
        <div>
          <Button type="button" variant="outline" disabled={disabled || restricted} onClick={() => setOpen(true)}>
            {t("payment.reverseAction")}
          </Button>
        </div>
      )}

      {!finalized && open && (
        <form onSubmit={handleReverse} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("payment.reverseConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("payment.reverseSubmit")}</Button>
          </div>
        </form>
      )}
    </li>
  );
}
