import { z } from "zod";
import { CURRENCIES } from "@/lib/payments/format-money";

/**
 * Ordinary payment-entry UI brief §2.4b/§2.4c: the browser-side `submissionId`/payload persistence this feature's own
 * merged prerequisite (PR #89) deliberately left for this PR to build. A plain module — never `"use server"`, runs
 * entirely in the browser. No network, no DB; `localStorage` only.
 *
 * KEY SHAPE: `payment-attempt:{organizationId}:{userId}:{submissionId}` — scoped by user AND organization (never
 * organization alone, so a shared staff workstation can't show one staff member another's draft), keyed per attempt
 * (never one overwritable global slot, so two tabs starting different attempts never clobber each other's entries).
 * The `submissionId` lives in the KEY itself, not only the value — so it stays recoverable by scanning keys even if
 * the stored VALUE is fully corrupt (the only way it could be lost is a key that fails to parse, which cannot happen
 * for a `crypto.randomUUID()`-shaped id, since those never contain `:`).
 *
 * WRITE-ONCE: `beginAttempt` refuses to overwrite an existing, still-present entry for the same key (brief §2.4b
 * point 2 — edited form fields can never clobber an uncertain attempt's own stored payload). Clearing is the only way
 * to free a key for reuse, and clearing is gated by the recovery-state table (§2.4c), never by a bare lookup failure.
 */

const calendarDateSchema = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });

export const storedAttemptPayloadSchema = z.object({
  studentId: z.string().min(1),
  obligationIds: z.array(z.string().min(1)).min(1),
  receivedOn: calendarDateSchema,
  tender: z.object({ currency: z.enum(CURRENCIES), amount: z.string().min(1) }),
  method: z.string().min(1),
  notes: z.string().optional(),
});
export type StoredAttemptPayload = z.infer<typeof storedAttemptPayloadSchema>;

const PREFIX = "payment-attempt:";

function keyFor(organizationId: string, userId: string, submissionId: string): string {
  return `${PREFIX}${organizationId}:${userId}:${submissionId}`;
}

/** Split a storage key back into its parts. Returns `null` for anything not shaped like `keyFor`'s own output
 * (defensively — this module never trusts `localStorage` isn't shared with something else). */
function parseKey(key: string): { organizationId: string; userId: string; submissionId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  return { organizationId: parts[0], userId: parts[1], submissionId: parts[2] };
}

export type BeginAttemptResult =
  | { ok: true }
  /** An entry already exists for this exact key — write-once (point 2): never silently overwritten. The caller must
   * read the existing entry (readAttempt) rather than proceed with a new payload under the same submissionId. */
  | { ok: false; error: "alreadyExists" }
  /** `localStorage.setItem` itself threw (private browsing, quota, disabled storage) — the brief's own corrected
   * rule: this BLOCKS submission entirely. There is no "warn and proceed anyway" path. */
  | { ok: false; error: "storageUnavailable" };

/** Durable persistence BEFORE the network request (brief §2.4b) — call this first; only submit if it returns `ok`. */
export function beginAttempt(organizationId: string, userId: string, submissionId: string, payload: StoredAttemptPayload): BeginAttemptResult {
  const key = keyFor(organizationId, userId, submissionId);
  try {
    if (window.localStorage.getItem(key) !== null) return { ok: false, error: "alreadyExists" };
    window.localStorage.setItem(key, JSON.stringify(payload));
    return { ok: true };
  } catch {
    return { ok: false, error: "storageUnavailable" };
  }
}

export type ReadAttemptResult =
  | { status: "missing" }
  | { status: "ok"; payload: StoredAttemptPayload }
  /** The value failed to parse (JSON or schema) — NEVER treated as proof nothing was recorded (brief §2.4b). The
   * `submissionId` itself is still known (it came from the key, not the value), so a status check remains possible;
   * the payload for a retry is not. */
  | { status: "corrupt" };

export function readAttempt(organizationId: string, userId: string, submissionId: string): ReadAttemptResult {
  const key = keyFor(organizationId, userId, submissionId);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return { status: "missing" };
  }
  if (raw === null) return { status: "missing" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  const parsed = storedAttemptPayloadSchema.safeParse(json);
  if (!parsed.success) return { status: "corrupt" };
  return { status: "ok", payload: parsed.data };
}

/** Removes exactly the targeted entry. Called only per the recovery-state table (§2.4c) — a definitive resolved
 * outcome, or an explicit, deliberate owner action — never on a bare lookup failure and never from a sign-out
 * handler (this module exposes no such handler on purpose: nothing here reacts to auth state). */
export function clearAttempt(organizationId: string, userId: string, submissionId: string): void {
  try {
    window.localStorage.removeItem(keyFor(organizationId, userId, submissionId));
  } catch {
    // Nothing to do: if storage is unavailable for removal, it was equally unavailable for everything else this
    // session, and there is no durable state to leave dangling.
  }
}

/** Every `submissionId` currently stored for this user+org (brief's reload-recovery mount check) — a plain key scan,
 * not a second index to keep in sync. Ordinarily 0 or 1 (write-once, cleared on resolution); more than one means two
 * tabs each started an attempt that is still uncertain — each is reported, none is preferred over another. */
export function listStoredAttemptIds(organizationId: string, userId: string): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      const parsed = parseKey(key);
      if (parsed && parsed.organizationId === organizationId && parsed.userId === userId) ids.push(parsed.submissionId);
    }
  } catch {
    return [];
  }
  return ids;
}
