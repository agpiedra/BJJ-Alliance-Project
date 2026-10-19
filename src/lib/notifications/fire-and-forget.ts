import { after } from "next/server";
import { safeErrorCode } from "@/lib/auth/password-reset-log";

/**
 * Fires a best-effort background job (a notification dispatch) so it
 * survives past the HTTP response on Vercel's serverless runtime — once a
 * response is sent the function instance can be frozen/terminated, and a
 * plain un-awaited promise has no guarantee of ever completing. Registering
 * it with Next's `after()` (stable since Next 15, no `experimental` flag
 * needed here — confirmed against this repo's installed `next@15.5.25`)
 * keeps the instance alive until `work` settles.
 *
 * `after()` throws SYNCHRONOUSLY when called outside a real Next.js request
 * scope (verified by reading `next/dist/server/after/after.js`: it reads an
 * AsyncLocalStorage-backed work store and throws immediately if none is
 * set) — which is exactly what happens when this codebase's integration
 * tests call `performCheckIn` or the signup action directly instead of
 * through a real Next.js request (and, for what it's worth, would also
 * happen if the route/action handlers themselves were invoked directly the
 * way this suite's route- and action-level tests already do — there is no
 * real request-scoped store in either case). The try/catch below falls back
 * to the plain fire-and-forget behavior these direct-call tests already
 * exercise and assert on.
 */
const JOB_LABELS = ["notifyNewSignup", "notifyEligibilityReached"] as const;
export type FireAndForgetLabel = (typeof JOB_LABELS)[number];

export function fireAndForget(label: FireAndForgetLabel, work: () => Promise<void>): void {
  // Fixed event, allow-listed job name and error code — never the caller's string or the raw error, either of which can
  // carry an address, link or query parameter. The runtime check covers a caller that bypasses the type.
  const job = (JOB_LABELS as readonly string[]).includes(label) ? label : "unrecognized_job";
  const run = () =>
    work().catch((error) => console.error("background job failed (non-fatal)", { job, error: safeErrorCode(error) }));
  try {
    after(run);
  } catch {
    run();
  }
}
