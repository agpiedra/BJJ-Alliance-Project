import { z } from "zod";
import type { PaymentMethod } from "@/generated/prisma/client";
import { CURRENCIES } from "@/lib/payments/format-money";
import { parseMoney } from "@/lib/dues/config-input";

/** A hardcoded literal array satisfying `PaymentMethod`, mirroring `CURRENCIES`'s own established pattern
 * (`format-money.ts`) — NEVER `Object.values(PaymentMethod)` imported as a VALUE from `@/generated/prisma/client`:
 * that pulls the real generated Prisma client runtime into this client-side bundle (confirmed directly — `next build`
 * fails with "the chunking context does not support external modules (request: node:module)" the moment this file
 * imports the enum as a value rather than a type). */
const PAYMENT_METHODS = ["SINPE", "TRANSFERENCIA", "EFECTIVO", "TARJETA"] as const satisfies readonly PaymentMethod[];

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

/** A plausible calendar date — the same discipline `isRealDate` (`dues/ledger/common.ts`) applies, reimplemented
 * locally rather than imported: that module sits under `dues/ledger/` and pulls in `@/lib/students/lock` (a
 * prisma-touching chain) transitively, which must never reach a client bundle. Deliberately matches the ledger's own
 * supported year range (2000-2100) so a value this module accepts is never later rejected by the server purely on
 * range grounds. */
function isPlausibleCalendarDate(d: { year: number; month: number; day: number }): boolean {
  if (d.year < 2000 || d.year > 2100) return false;
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return date.getUTCFullYear() === d.year && date.getUTCMonth() === d.month - 1 && date.getUTCDate() === d.day;
}

const calendarDateSchema = z
  .object({ year: z.number().int(), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
  .refine(isPlausibleCalendarDate, { message: "not a real calendar date" });

/** A schema-valid-but-semantically-garbage stored value (e.g. `method: "not-a-method"`, an unparseable `amount`, a
 * duplicate-id `obligationIds`) must classify as unusable/corrupt, not be trusted for a retry — point 5's correction.
 * Reuses `parseMoney` (the same canonical-amount check the engine itself applies), never a bespoke regex. */
export const storedAttemptPayloadSchema = z.object({
  studentId: z.string().min(1),
  obligationIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate obligationIds" }),
  receivedOn: calendarDateSchema,
  tender: z.object({
    currency: z.enum(CURRENCIES),
    amount: z.string().refine((a) => parseMoney(a, { allowZero: false }).ok, { message: "not a valid money amount" }),
  }),
  method: z.enum(PAYMENT_METHODS),
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
  | { status: "corrupt" }
  /** `localStorage.getItem` itself threw — point 5's correction: distinct from "missing" (a genuinely absent key).
   * "Can't tell" is never treated as "nothing is there." */
  | { status: "unavailable" };

export function readAttempt(organizationId: string, userId: string, submissionId: string): ReadAttemptResult {
  const key = keyFor(organizationId, userId, submissionId);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return { status: "unavailable" };
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

export type ClearAttemptResult = { ok: true } | { ok: false; error: "unavailable" };

/** Removes exactly the targeted entry. Called only per the recovery-state table (§2.4c) — a definitive resolved
 * outcome, or an explicit, deliberate owner action — never on a bare lookup failure and never from a sign-out
 * handler (this module exposes no such handler on purpose: nothing here reacts to auth state). Returns a result the
 * caller must check (point 5): if removal genuinely failed, the caller must NOT assume the entry is gone. */
export function clearAttempt(organizationId: string, userId: string, submissionId: string): ClearAttemptResult {
  try {
    window.localStorage.removeItem(keyFor(organizationId, userId, submissionId));
    return { ok: true };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export type ListStoredAttemptIdsResult = { status: "ok"; ids: string[] } | { status: "unavailable" };

/** Every `submissionId` currently stored for this user+org (brief's reload-recovery mount check) — a plain key scan,
 * not a second index to keep in sync. Ordinarily 0 or 1 (write-once, cleared on resolution); more than one means two
 * tabs each started an attempt that is still uncertain — each is reported, none is preferred over another.
 * Point 5's correction: a scan failure is `{status:"unavailable"}`, distinct from `{status:"ok", ids:[]}` (genuinely
 * nothing stored) — the caller must treat "couldn't inspect storage" as blocking, never as "nothing to recover." */
export function listStoredAttemptIds(organizationId: string, userId: string): ListStoredAttemptIdsResult {
  const ids: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      const parsed = parseKey(key);
      if (parsed && parsed.organizationId === organizationId && parsed.userId === userId) ids.push(parsed.submissionId);
    }
  } catch {
    return { status: "unavailable" };
  }
  return { status: "ok", ids };
}
