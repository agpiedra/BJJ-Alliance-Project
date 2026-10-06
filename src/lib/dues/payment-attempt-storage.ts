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
 *
 * Package-purchase UI brief §2.6/§2.10: the KEY FORMAT is unchanged and shared across every operation (ORDINARY,
 * PACKAGE, and later PREPAYMENT) — there is no per-writer namespace at the storage layer, mirroring the single
 * `DuesPaymentAttempt` table's own global `submissionId` uniqueness. The stored VALUE now carries an explicit
 * `operation` discriminator, the identical fail-closed discipline `submission-identity.ts`'s own `readStoredOperation`
 * already applies on the database side: an explicit, valid `operation` is trusted directly; failing that, the legacy
 * `"ORDINARY"` default is granted ONLY once the REST of the payload independently validates as a genuine legacy
 * ordinary payload; anything else classifies as unclassifiable, never silently coerced to `"ORDINARY"`.
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

const yearMonthSchema = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) });

/** A schema-valid-but-semantically-garbage stored value (e.g. `method: "not-a-method"`, an unparseable `amount`, a
 * duplicate-id `obligationIds`) must classify as unusable/corrupt, not be trusted for a retry — point 5's correction.
 * Reuses `parseMoney` (the same canonical-amount check the engine itself applies), never a bespoke regex.
 *
 * Package-purchase UI brief §2.10: `operation` is a literal `"ORDINARY"`, defaulted ONLY for a key-absent (legacy,
 * pre-this-PR) entry — never widened to accept `"PACKAGE"`/`"PREPAYMENT"`, so this schema itself is what makes a
 * foreign-operation entry fail to parse as an ordinary attempt (the exact-match half of the 3-way partition below). */
export const storedAttemptPayloadSchema = z.object({
  operation: z.literal("ORDINARY").default("ORDINARY"),
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

/** Package-purchase UI brief §2.10: the package card's own stored payload shape — disjoint fields from the ordinary
 * one above (`planTermsId`/`requestedStartMonth` in place of a bare `obligationIds` list), mirroring
 * `purchase-submission-identity.ts`'s own `packageCanonicalPayloadSchema` exactly (never a drifting second copy of
 * its validation rules; `existingObligationIds` here is optional-defaulting-to-empty since the package card's own
 * draft may have none selected yet, unlike the engine's canonical payload which always has the array present). */
export const storedPackageAttemptPayloadSchema = z.object({
  operation: z.literal("PACKAGE"),
  studentId: z.string().min(1),
  planTermsId: z.string().min(1),
  requestedStartMonth: yearMonthSchema,
  existingObligationIds: z
    .array(z.string().min(1))
    .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate existingObligationIds" }),
  receivedOn: calendarDateSchema,
  tender: z.object({
    currency: z.enum(CURRENCIES),
    amount: z.string().refine((a) => parseMoney(a, { allowZero: false }).ok, { message: "not a valid money amount" }),
  }),
  method: z.enum(PAYMENT_METHODS),
  notes: z.string().optional(),
});
export type StoredPackageAttemptPayload = z.infer<typeof storedPackageAttemptPayloadSchema>;

/** The `operation` discriminator alone, from ANY stored payload, without knowing in advance which schema to validate
 * against — the browser-storage mirror of `submission-identity.ts`'s own `readStoredOperation`. MUST fail closed:
 * an explicit, valid `operation` is trusted directly; failing that, `"ORDINARY"` is granted ONLY once the rest of
 * the payload independently validates as a genuine legacy ordinary attempt (reusing `storedAttemptPayloadSchema`
 * itself, whose own `.default("ORDINARY")` is exactly what lets a key-absent-but-otherwise-valid payload parse as
 * that); anything else — a non-object, an invalid `operation` value, or a payload broken on some OTHER field —
 * resolves `"UNKNOWN"`, never `"ORDINARY"`. */
const operationFieldSchema = z.object({ operation: z.enum(["ORDINARY", "PACKAGE", "PREPAYMENT"]) }).passthrough();
export type AttemptOperation = "ORDINARY" | "PACKAGE" | "PREPAYMENT";
export function readStoredOperation(json: unknown): AttemptOperation | "UNKNOWN" {
  const explicit = operationFieldSchema.safeParse(json);
  if (explicit.success) return explicit.data.operation;
  const asLegacyOrdinary = storedAttemptPayloadSchema.safeParse(json);
  if (asLegacyOrdinary.success && asLegacyOrdinary.data.operation === "ORDINARY") return "ORDINARY";
  return "UNKNOWN";
}

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

/** Durable persistence BEFORE the network request (brief §2.4b) — call this first; only submit if it returns `ok`.
 * Package-purchase UI brief §2.10: genericized over the payload TYPE (was `StoredAttemptPayload` only) — this
 * function never validated its argument against any schema to begin with (it only `JSON.stringify`s whatever is
 * given), so widening the parameter is a type-level change only, zero behavior change for the ordinary card's own
 * existing calls. Shared by both cards rather than a duplicate "beginPackageAttempt" with identical logic. */
export function beginAttempt<T>(organizationId: string, userId: string, submissionId: string, payload: T): BeginAttemptResult {
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

export type ReadPackageAttemptResult =
  | { status: "missing" }
  | { status: "ok"; payload: StoredPackageAttemptPayload }
  | { status: "corrupt" }
  | { status: "unavailable" };

/** `readAttempt`'s own exact counterpart for the package card — identical control flow, validated against
 * `storedPackageAttemptPayloadSchema` instead. A row written by the ORDINARY card (or any other operation) fails
 * this schema (disjoint required fields, and `operation` is the literal `"PACKAGE"` with no default) and reads as
 * `"corrupt"` here — correct: this function is only ever called by the package card for an id it already knows, via
 * `scanAttemptsByOperation`, is its OWN entry; a foreign entry reaching it would itself be the bug. */
export function readPackageAttempt(organizationId: string, userId: string, submissionId: string): ReadPackageAttemptResult {
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
  const parsed = storedPackageAttemptPayloadSchema.safeParse(json);
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

export type ScanAttemptsByOperationResult =
  | {
      status: "ok";
      /** This card's own operation — process exactly like `listStoredAttemptIds` used to for every id. */
      matching: string[];
      /** A different, KNOWN operation — another card owns it; never read, cleared, or acted on here. */
      otherOperations: string[];
      /** Malformed JSON, an unrecognized `operation` value, or a per-entry `getItem` throw during an otherwise-
       * successful enumeration — owned SOLELY by the ordinary card (brief §2.10), offered only a status check. */
      unclassifiable: string[];
    }
  | { status: "unavailable" };

/**
 * Package-purchase UI brief §2.6/§2.10: the operation-aware scan — every stored entry for this user+org lands in
 * EXACTLY ONE of three buckets, none ever silently dropped (the corrected design: a binary "filter by operation"
 * scan would silently drop any entry whose operation can't be determined, making it invisible to every card; this
 * scan has an explicit third bucket for exactly that). `listStoredAttemptIds` above is unaffected and kept for its
 * own simpler callers/tests; this is a superset classification, not a replacement of that primitive.
 *
 * A key-enumeration failure (the whole `localStorage.length`/`.key(i)` loop itself throwing) is `{status:
 * "unavailable"}`, identical to `listStoredAttemptIds`'s own rule — "can't verify storage at all" is distinct from
 * "verified, and this one entry's value couldn't be read" (which instead lands the SPECIFIC entry in
 * `unclassifiable`, per brief point 10's "a per-entry `getItem` throw" case, since every OTHER entry's own scan can
 * still proceed normally).
 */
export function scanAttemptsByOperation(organizationId: string, userId: string, operation: AttemptOperation): ScanAttemptsByOperationResult {
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch {
    return { status: "unavailable" };
  }

  const matching: string[] = [];
  const otherOperations: string[] = [];
  const unclassifiable: string[] = [];
  for (const key of keys) {
    const parsed = parseKey(key);
    if (!parsed || parsed.organizationId !== organizationId || parsed.userId !== userId) continue;

    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      unclassifiable.push(parsed.submissionId);
      continue;
    }
    if (raw === null) continue; // vanished between key enumeration and read — genuinely nothing to report

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      unclassifiable.push(parsed.submissionId);
      continue;
    }

    const entryOperation = readStoredOperation(json);
    if (entryOperation === "UNKNOWN") {
      unclassifiable.push(parsed.submissionId);
    } else if (entryOperation === operation) {
      matching.push(parsed.submissionId);
    } else {
      otherOperations.push(parsed.submissionId);
    }
  }
  return { status: "ok", matching, otherOperations, unclassifiable };
}
