import { requireEnv } from "@/lib/env";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — organization logo storage.
 *
 * Supabase Storage, not Postgres bytes (the original Phase 4 draft's
 * `DbLogoStorage`-adapter idea was explicitly conditioned on "the production
 * provider is not chosen yet" — it now has). Plain `fetch` against Supabase's
 * Storage REST API rather than the `@supabase/supabase-js` SDK: this needs
 * exactly two calls (upload, delete), and the SDK would pull in its
 * auth/realtime/postgrest clients for no benefit over two `fetch` calls this
 * module already fully controls.
 *
 * **This bucket is PUBLIC by deliberate design, not by omission.** Logos
 * render on the unauthenticated kiosk check-in screen (the whole point of
 * Phase 4's own "kiosk matters most" framing) — there is no meaningful
 * access control to put in front of an image every student in the gym
 * already sees on a shared tablet. Nothing else may ever be uploaded here:
 * this module is the ONLY code path that writes to `SUPABASE_LOGO_BUCKET`,
 * and it accepts exactly one thing, a validated logo image. A future
 * feature needing private storage must use a separate bucket, never this
 * one — reusing a public bucket for anything sensitive would leak it.
 *
 * Env vars are read lazily, inside each function, not at module load —
 * importing this module must never crash a process that hasn't configured
 * Supabase yet, matching this codebase's existing `Resend`/`EmailChannel`
 * convention of deferring `requireEnv` to the point of actual use.
 */

function storageBase(): string {
  return `${requireEnv("SUPABASE_URL")}/storage/v1`;
}

function bucket(): string {
  return process.env.SUPABASE_LOGO_BUCKET || "org-branding";
}

function authHeaders(): Record<string, string> {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/**
 * A new path per upload (`{organizationId}/{timestamp}.{ext}`), never a
 * stable one reused across uploads — this is what lets logo replacement
 * skip cache-invalidation logic entirely (ETags, Cache-Control headers)
 * rather than needing it: a new URL is never stale by definition.
 */
function objectPath(organizationId: string, mimeType: string, uploadedAt: Date): string {
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${organizationId}/${uploadedAt.getTime()}.${ext}`;
}

export function publicLogoUrl(path: string): string {
  return `${requireEnv("SUPABASE_URL")}/storage/v1/object/public/${bucket()}/${path}`;
}

export interface UploadedLogo {
  path: string;
  url: string;
}

/**
 * Every way this module's two Supabase Storage calls can fail, narrow
 * enough for the branding actions to give distinct (if intentionally
 * shared-copy, per the approved PR 1 design) user feedback without leaking
 * infrastructure details.
 */
export type LogoStorageError = "permissionDenied" | "bucketMissing" | "storageRateLimited" | "storageUnavailable";

export interface StorageFailure {
  ok: false;
  error: LogoStorageError;
  /** HTTP status, when the failure produced one — absent for a network
   * failure, a timeout, or a missing/invalid env var (none of these ever
   * reached the network). */
  status?: number;
  /** Supabase's own machine-readable error code and message (see
   * https://supabase.com/docs/guides/storage/debugging/error-codes),
   * carried through for the server-side log ONLY — never rendered to a
   * user, per this module's own public-bucket-but-no-secrets posture. */
  providerCode?: string;
  providerMessage?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Status-code fallback, used only when the response body doesn't carry a
 * `code` this module recognizes (a malformed/non-JSON body, or a genuinely
 * unrecognized code) — see `classifyResponse` below. Status alone is a
 * coarser signal than Supabase's own `code`: a 404 covers both "the bucket
 * doesn't exist" (`NoSuchBucket`) and "the whole project reference is
 * wrong" (`TenantNotFound`, a deeper misconfiguration), and a 503 covers
 * both "something broke" and `SlowDown` (a rate-limit signal, same meaning
 * as 429). The code-based classification below exists specifically to tell
 * those apart; this function is the honest "we don't know, guess from the
 * status" behavior for everything it can't.
 */
function classifyStatus(status: number): LogoStorageError {
  if (status === 401 || status === 403) return "permissionDenied";
  if (status === 404) return "bucketMissing";
  if (status === 429) return "storageRateLimited";
  return "storageUnavailable";
}

/**
 * Supabase Storage's own documented error codes
 * (https://supabase.com/docs/guides/storage/debugging/error-codes) that
 * this module's two operations (upload, delete) can realistically hit and
 * that `classifyStatus`'s status-only view gets wrong or merely guesses
 * at: `TenantNotFound` and `NoSuchBucket` share HTTP 404 but mean very
 * different things (a bucket to create vs. a provisioning problem to
 * escalate); `SlowDown` (503) is a rate-limit signal `classifyStatus` would
 * otherwise lump in with "something broke." Deliberately NOT exhaustive —
 * every code Supabase document that this module's two operations can't
 * realistically produce (e.g. `InvalidUploadId`, an S3 multipart-upload
 * concept this module never uses) is left out; an unrecognized or absent
 * code falls back to `classifyStatus`.
 */
const KNOWN_ERROR_CODES: Partial<Record<string, LogoStorageError>> = {
  InvalidJWT: "permissionDenied",
  AccessDenied: "permissionDenied",
  SignatureDoesNotMatch: "permissionDenied",
  InvalidSignature: "permissionDenied",
  S3InvalidAccessKeyId: "permissionDenied",
  NoSuchBucket: "bucketMissing",
  TenantNotFound: "storageUnavailable",
  SlowDown: "storageRateLimited",
};

async function readErrorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const { code, message } = body as { code?: unknown; message?: unknown };
      return {
        code: typeof code === "string" ? code : undefined,
        message: typeof message === "string" ? message : undefined,
      };
    }
  } catch {
    // Non-JSON or malformed body — classifyStatus's fallback below handles it.
  }
  return {};
}

async function classifyResponse(response: Response): Promise<StorageFailure> {
  const { code, message } = await readErrorBody(response);
  const error = (code && KNOWN_ERROR_CODES[code]) || classifyStatus(response.status);
  return { ok: false, error, status: response.status, providerCode: code, providerMessage: message };
}

/**
 * `buildRequest` is called INSIDE this function's own try — not before —
 * so that a missing/invalid env var (`storageBase()`/`authHeaders()`
 * calling `requireEnv`) is a classified `storageUnavailable` result like
 * any other failure to reach storage, never an uncaught throw. This is
 * what makes `uploadLogo`/`deleteLogoByUrl`'s "never throws" claim actually
 * true instead of true-except-for-configuration.
 */
async function storageFetch(
  buildRequest: () => { url: string; init: RequestInit },
): Promise<{ ok: true; response: Response } | StorageFailure> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { url, init } = buildRequest();
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return classifyResponse(response);
    return { ok: true, response };
  } catch {
    // Network failure, DNS failure, our own timeout above, or `buildRequest`
    // itself throwing (a missing env var) — none of these produce an HTTP
    // status or a provider error code to classify, and all of them mean the
    // same thing to a caller: storage could not be reached right now.
    return { ok: false, error: "storageUnavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Uploads validated logo bytes and returns the object's path (stored
 * nowhere itself — callers persist `url`) and its public URL, or a
 * classified `StorageFailure` on any non-2xx response, unreachable
 * storage, or missing configuration. Never throws. The caller (the server
 * action) is responsible for the upload -> DB-write -> delete-old-object
 * ordering that keeps a row from ever pointing at a deleted file (never
 * delete-then-upload).
 */
export async function uploadLogo(
  organizationId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ ok: true; result: UploadedLogo } | StorageFailure> {
  const path = objectPath(organizationId, mimeType, new Date());
  const result = await storageFetch(() => ({
    url: `${storageBase()}/object/${bucket()}/${path}`,
    init: {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": mimeType, "x-upsert": "false" },
      // `fetch`'s BodyInit overloads don't include Node's Buffer type
      // directly even though Buffer IS a Uint8Array at runtime.
      body: new Uint8Array(bytes),
    },
  }));
  if (!result.ok) return result;
  // Safe to call unguarded: reaching here means `storageBase()` (inside
  // `buildRequest` above) already resolved SUPABASE_URL without throwing.
  return { ok: true, result: { path, url: publicLogoUrl(path) } };
}

/**
 * Best-effort: called only AFTER the DB row that referenced this object has
 * already committed its own change (new logo written, or `logoUrl` cleared
 * — see the two call sites), to remove the now-orphaned object. Never
 * throws — a failure here leaks one storage object rather than breaking
 * the save/removal the director is waiting on, matching
 * `finalizeKioskAttempt`'s own "must not fail the caller's real success
 * over metadata cleanup" reasoning. Returns the classified failure (never
 * just a boolean) so the CALLER can log it with both this module's own
 * detail AND the domain context (organization id, upload-vs-remove) this
 * module doesn't have — see PR 1's investigation for why: a cleanup
 * failure must be reported as its own thing, never as "the operation
 * failed," since the operation the user asked for (upload a new logo, or
 * remove one) already committed successfully.
 */
export async function deleteLogoByUrl(url: string): Promise<{ ok: true } | StorageFailure> {
  const marker = `/object/public/${bucket()}/`;
  const index = url.indexOf(marker);
  if (index === -1) {
    return { ok: false, error: "storageUnavailable", providerMessage: "URL did not match the expected object marker" };
  }
  const path = url.slice(index + marker.length);

  const result = await storageFetch(() => ({
    url: `${storageBase()}/object/${bucket()}/${path}`,
    init: { method: "DELETE", headers: authHeaders() },
  }));
  return result.ok ? { ok: true } : result;
}
