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
 * Uploads validated logo bytes and returns the object's path (stored
 * nowhere itself — callers persist `url`) and its public URL. Throws on any
 * non-2xx response; the caller (the server action) is responsible for the
 * upload -> DB-write -> delete-old-object ordering that keeps a row from
 * ever pointing at a deleted file (never delete-then-upload).
 */
export async function uploadLogo(
  organizationId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<UploadedLogo> {
  const path = objectPath(organizationId, mimeType, new Date());
  const response = await fetch(`${storageBase()}/object/${bucket()}/${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mimeType, "x-upsert": "false" },
    // `fetch`'s BodyInit overloads don't include Node's Buffer type
    // directly even though Buffer IS a Uint8Array at runtime.
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`Supabase logo upload failed: ${response.status} ${await response.text()}`);
  }
  return { path, url: publicLogoUrl(path) };
}

/**
 * Best-effort: called only AFTER the new logo's DB row has already
 * committed (see the save action), to remove the now-orphaned previous
 * object. A failure here leaks one storage object rather than breaking the
 * save the director is waiting on — logged, never thrown, matching
 * `finalizeKioskAttempt`'s own "must not fail the caller's real success
 * over metadata cleanup" reasoning.
 */
export async function deleteLogoByUrl(url: string): Promise<void> {
  const marker = `/object/public/${bucket()}/`;
  const index = url.indexOf(marker);
  if (index === -1) return;
  const path = url.slice(index + marker.length);

  try {
    const response = await fetch(`${storageBase()}/object/${bucket()}/${path}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!response.ok) {
      console.error("[logo-storage] failed to delete old logo object", { path, status: response.status });
    }
  } catch (error) {
    console.error("[logo-storage] failed to delete old logo object", { path, error });
  }
}
