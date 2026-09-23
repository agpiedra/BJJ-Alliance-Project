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
 * infrastructure details. Classified from the HTTP response the same way
 * `src/lib/kiosk/offline-queue.ts` classifies its own external-response
 * statuses — status code decides the category, not string-matching a body.
 */
export type LogoStorageError = "permissionDenied" | "bucketMissing" | "storageRateLimited" | "storageUnavailable";

const REQUEST_TIMEOUT_MS = 15_000;

function classifyStatus(status: number): LogoStorageError {
  if (status === 401 || status === 403) return "permissionDenied";
  if (status === 404) return "bucketMissing";
  if (status === 429) return "storageRateLimited";
  return "storageUnavailable";
}

async function storageFetch(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; response: Response } | { ok: false; error: LogoStorageError; status?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: classifyStatus(response.status), status: response.status };
    }
    return { ok: true, response };
  } catch {
    // Network failure, DNS failure, or our own timeout above — none of
    // these produce an HTTP status to classify, and all three mean the
    // same thing to a caller: storage could not be reached right now.
    return { ok: false, error: "storageUnavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Uploads validated logo bytes and returns the object's path (stored
 * nowhere itself — callers persist `url`) and its public URL, or a
 * classified `LogoStorageError` on any non-2xx response or unreachable
 * storage. Never throws. The caller (the server action) is responsible for
 * the upload -> DB-write -> delete-old-object ordering that keeps a row
 * from ever pointing at a deleted file (never delete-then-upload).
 */
export async function uploadLogo(
  organizationId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ ok: true; result: UploadedLogo } | { ok: false; error: LogoStorageError; status?: number }> {
  const path = objectPath(organizationId, mimeType, new Date());
  const result = await storageFetch(`${storageBase()}/object/${bucket()}/${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mimeType, "x-upsert": "false" },
    // `fetch`'s BodyInit overloads don't include Node's Buffer type
    // directly even though Buffer IS a Uint8Array at runtime.
    body: new Uint8Array(bytes),
  });
  if (!result.ok) return result;
  return { ok: true, result: { path, url: publicLogoUrl(path) } };
}

/**
 * Best-effort: called only AFTER the DB row that referenced this object has
 * already committed its own change (new logo written, or `logoUrl` cleared
 * — see the two call sites), to remove the now-orphaned object. Never
 * throws — a failure here leaks one storage object rather than breaking
 * the save/removal the director is waiting on, matching
 * `finalizeKioskAttempt`'s own "must not fail the caller's real success
 * over metadata cleanup" reasoning. Returns whether the delete actually
 * succeeded so the CALLER can log it with the domain context (organization
 * id, upload-vs-remove) this module doesn't have — see PR 1's investigation
 * for why: a cleanup failure must be reported as its own thing, never as
 * "the operation failed," since the operation the user asked for (upload a
 * new logo, or remove one) already committed successfully.
 */
export async function deleteLogoByUrl(url: string): Promise<{ ok: boolean }> {
  const marker = `/object/public/${bucket()}/`;
  const index = url.indexOf(marker);
  if (index === -1) return { ok: false };
  const path = url.slice(index + marker.length);

  const result = await storageFetch(`${storageBase()}/object/${bucket()}/${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return { ok: result.ok };
}
