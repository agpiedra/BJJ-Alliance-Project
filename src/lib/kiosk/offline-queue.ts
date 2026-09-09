/**
 * IndexedDB-backed FIFO queue for kiosk check-ins submitted while offline.
 *
 * This module only ever runs in the browser (it's imported exclusively by
 * the "use client" kiosk-client.tsx), so it doesn't guard against SSR
 * execution — but every entry point still feature-detects `indexedDB`
 * itself, since a handful of browsers/embedded webviews still lack it.
 *
 * Design notes (Task 7, spec §10):
 * - `enqueueOfflineCheckIn` is called instead of showing an error when a
 *   submission can't reach the server because the device is offline.
 * - `flushOfflineQueue` replays queued entries SEQUENTIALLY (never in
 *   parallel) and awaits each result before starting the next. This
 *   matters for correctness: if a student mis-tapped and checked in twice
 *   while offline, the second attempt must be rejected by the server as
 *   `already_checked_in` — which only works if the first one has already
 *   been committed by the time the second one replays.
 * - An entry is removed from the queue on a "definitive" outcome (success,
 *   or a real rejection the server will never reverse). An entry is LEFT
 *   in the queue — and the whole flush stops — on anything that looks like
 *   a connectivity problem, so it can be retried the next time the
 *   `online` event fires.
 */

const DB_NAME = "kiosk-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "checkins";
const CHECK_IN_ENDPOINT = "/api/kiosk/check-in";

export interface OfflineCheckInPayload {
  academySlug: string;
  token: string;
  code: string;
}

interface StoredCheckIn extends OfflineCheckInPayload {
  id: number;
  queuedAt: number;
}

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllEntries(db: IDBDatabase): Promise<StoredCheckIn[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    // getAll() on an auto-incrementing keyPath store returns rows in
    // ascending key order, i.e. FIFO (insertion) order.
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as StoredCheckIn[]);
    request.onerror = () => reject(request.error);
  });
}

function deleteEntry(db: IDBDatabase, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Queue a check-in that couldn't be submitted because the device appears to
 * be offline.
 *
 * Returns `true` iff the entry was genuinely, durably persisted to
 * IndexedDB, and `false` if IndexedDB isn't available in this environment
 * (a handful of locked-down/embedded webviews lack it) — there is nowhere
 * safe to persist the attempt in that case. The caller MUST check this
 * return value: it is the only way to tell "safely queued" from "silently
 * lost" apart, and showing the reassuring "will sync" message without
 * checking it would falsely tell a student their check-in is safe when it
 * was never recorded anywhere.
 *
 * A genuine IndexedDB failure while persisting (e.g. `QuotaExceededError`,
 * or a blocked/corrupted database — the transaction's `onerror` path) is
 * deliberately NOT folded into the `false` return: it rejects the returned
 * promise instead, so callers can tell "this environment can never queue"
 * apart from "queuing failed this one time," even though both currently
 * lead callers to the same user-facing fallback.
 */
export async function enqueueOfflineCheckIn(payload: OfflineCheckInPayload): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).add({ ...payload, queuedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return true;
}

function isFailureBody(body: unknown): body is { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.ok === false && typeof record.error === "string";
}

type ReplayOutcome = "definitive" | "retry";

/**
 * The result of replaying one entry.
 *
 * `dropped` marks the subset of `definitive` outcomes where the student's
 * attendance was permanently LOST — the server gave a final answer that isn't
 * a real verdict on the code itself (a rotated kiosk token, a class window
 * that closed before connectivity came back, a malformed request). Those are
 * reported up to the UI so a human can be told, because a devtools
 * `console.warn` on an unattended kiosk tablet is a channel nobody reads.
 *
 * A 200, an `already_checked_in`, or an `invalid_code` are NOT drops: nothing
 * was lost in the first two, and the third is a genuine, final answer about
 * the code the student typed.
 */
interface ReplayResult {
  outcome: ReplayOutcome;
  dropped: boolean;
}

/**
 * Replay classification rules (see module doc for the general principle).
 * Each branch documents *why* that response is definitive vs. a
 * connectivity-shaped condition worth retrying.
 */
async function replayEntry(entry: StoredCheckIn): Promise<ReplayResult> {
  let response: Response;
  try {
    response = await fetch(CHECK_IN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        academySlug: entry.academySlug,
        token: entry.token,
        code: entry.code,
        // The instant the student ACTUALLY tapped, not the instant
        // connectivity came back. Without it the server records the replay
        // time, which mis-stamps occurredAt/date and can attribute the
        // check-in to a later class (or reject it as no_active_class). The
        // server validates it and falls back to its own clock if it's absent,
        // in the future, or implausibly stale.
        queuedAt: entry.queuedAt,
      }),
    });
  } catch {
    // Thrown fetch = network-level failure: still offline, or the server is
    // unreachable. Not a verdict on this check-in at all — retry later.
    return { outcome: "retry", dropped: false };
  }

  if (response.status === 200) {
    // Success: the check-in landed. Done.
    return { outcome: "definitive", dropped: false };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // We got a response but couldn't parse it as JSON — an ambiguous
    // server-side problem, not a real answer about this check-in. Don't
    // guess; leave it queued rather than risk silently discarding a real
    // attendance attempt.
    return { outcome: "retry", dropped: false };
  }

  const reason = isFailureBody(body) ? body.error : undefined;

  if (response.status === 400) {
    // invalid_code / already_checked_in are genuine, final answers from the
    // server about this specific code — not connectivity failures — so the
    // entry is resolved either way. These are the expected/non-actionable
    // outcomes (a real, final verdict about the code itself) and are
    // intentionally NOT logged — logging them would be noise.
    //
    // no_active_class during a REPLAY (as opposed to the original,
    // real-time submission) means the class window ended before
    // connectivity came back. Nothing further can make this succeed, so
    // it's treated as definitive too, rather than retried forever. Unlike
    // already_checked_in, this silently costs the student their
    // attendance credit with no other record of the attempt, so it's
    // logged for the front desk to be able to investigate a "I checked in
    // and it says I didn't" report.
    //
    // invalid_request (or an unrecognized/malformed failure body) would
    // mean our own request body was malformed — enqueueOfflineCheckIn only
    // ever stores well-formed {academySlug, token, code} strings, so this
    // would indicate a bug, not a transient state; retrying an identical
    // malformed request can never succeed, so it's dropped rather than
    // retried forever, and logged since it indicates a real bug.
    if (reason === "no_active_class") {
      console.warn("[kiosk-offline-queue] offline check-in dropped: class window ended before replay", {
        entry,
        reason,
      });
      return { outcome: "definitive", dropped: true };
    }
    if (reason !== "already_checked_in" && reason !== "invalid_code") {
      console.warn("[kiosk-offline-queue] offline check-in dropped: invalid_request", { entry, reason });
      return { outcome: "definitive", dropped: true };
    }
    return { outcome: "definitive", dropped: false };
  }

  if (response.status === 401 || response.status === 404) {
    // invalid_token: the academy slug or kiosk token is wrong (e.g. an
    // admin rotated the kiosk token between queuing and replay). This is a
    // configuration problem that won't be fixed by waiting and retrying —
    // drop it rather than retry forever, but log it: a real student's
    // check-in silently vanishing with no trace is exactly the kind of
    // thing the front desk needs to be able to investigate later.
    console.warn("[kiosk-offline-queue] offline check-in dropped: invalid_token", { entry, reason });
    return { outcome: "definitive", dropped: true };
  }

  if (response.status === 429) {
    // rate_limited / locked_out are explicitly transient per the API's own
    // contract (they carry retryAfterSeconds) — NOT a verdict on this
    // check-in. Leave it queued and stop flushing; the next `online` event
    // (or a later flush) will retry once the window passes.
    return { outcome: "retry", dropped: false };
  }

  // Any other/unexpected status: be conservative. Don't discard a real
  // attendance attempt over an unrecognized response — retry later.
  return { outcome: "retry", dropped: false };
}

let isFlushing = false;

/** What a flush pass did, for the UI to surface to a human. */
export interface FlushSummary {
  /**
   * How many queued check-ins were permanently discarded during this pass
   * without the student getting credit. Non-zero means somebody was told
   * "saved, will sync" and it never did — the front desk needs to know.
   */
  dropped: number;
}

/**
 * Replay every queued check-in, in order, one at a time. Stops (leaving the
 * current and all later entries queued) the first time a request looks like
 * a connectivity failure, so a later `online` event can retry the whole
 * remaining queue from the front. Re-entrant calls are no-ops while a flush
 * is already in progress (and report zero drops, since they did nothing).
 */
export async function flushOfflineQueue(): Promise<FlushSummary> {
  if (!isIndexedDbAvailable()) return { dropped: 0 };
  if (isFlushing) return { dropped: 0 };

  isFlushing = true;
  let dropped = 0;
  try {
    const db = await openDb();
    let entries: StoredCheckIn[];
    try {
      entries = await getAllEntries(db);
    } finally {
      db.close();
    }

    for (const entry of entries) {
      const result = await replayEntry(entry);
      if (result.outcome === "retry") {
        return { dropped };
      }
      if (result.dropped) dropped++;

      const deleteDb = await openDb();
      try {
        await deleteEntry(deleteDb, entry.id);
      } finally {
        deleteDb.close();
      }
    }
  } finally {
    isFlushing = false;
  }

  return { dropped };
}
