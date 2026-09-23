# Spec — Multi-Organization (SaaS) + Kids Belt System

**For:** Claude Code, working in the BJJ Alliance Project repo
**Owner:** Alexis (platform admin / product owner)
**Status:** approved for implementation, build in phases
**Revision:** 44 — logo upload/removal are ADMIN/DIRECTOR (were silently ADMIN-only, arbitrarily narrower than the settings page itself), storage failures are a classified never-thrown result with distinct user-facing copy, and a masked-fixture defect in this project's own test suite (a "director can remove a logo" test that instantiated an ADMIN) is fixed and logged. Revision 43 — C2 (the /platform observability views) and Sentry are designed, approved, and deliberately deferred until Alliance has real usage and real errors to build them against — recorded so neither is mistaken for forgotten work; the engineering that blocks launch is now complete, and what remains (name, domain, accounts, deploy, bootstrap, terms of service) is entirely the user's own next steps. Revision 42 — C1: both scheduled jobs now write a `JobRun` history (real sent/failed/skipped counts, never masked as `ok: true` when something failed) and ping a Healthchecks.io dead-man's switch, finalizing the row BEFORE pinging so a killed process is a false alarm rather than silence; `GET /api/health` (public, database-only, briefly cached) and `GET /api/health/jobs` (behind `CRON_SECRET`, per-job staleness/stuck detection) give the platform its first real observability. Revision 41 — the tenant gates can no longer be permissive by omission: the role list is required at both `requireTenantContext` and `resolveActionContext`, every call names its roles as a literal, and the finding is recorded as its own pattern (a guard that holds only because another layer covers for it — the tally of "built it, never wired it" stays at fourteen); the sibling audit found `regenerateStudentCode` with the same shape (not exploitable, and fixed); a demoted-while-logged-in person is told, not sent to a bare 404; approving a student refreshes the page; and the join page stops telling a signed-in person to sign in. Revision 40 — B4: access is membership, not the global role — the middleware gates on a `{ staff, portal }` claim derived from the database, never on `User.role`; a stale claim is refreshed from the database (never a silent refusal, never "log out"), a missing one fails closed; one account reaches both the staff app and the portal (promotion in place at invitation acceptance, "Student only" to demote); and a real hole the new tests found — `requireTenantContext()` with no role list admitted students — is closed. Revision 39 — B5: an archived student can be restored, back to the status they had, from a **stored** `Student.statusBeforeArchive` — never read from the audit log; a pending applicant who logs in is told their registration is awaiting approval; the archive dialog stops promising what did not exist; and the kiosk "NaN" found in revision 38 is fixed (#47). Revision 38 — B3: an Owner can add a location (`/admin/locations`, add-only), its kiosk token is shown once and provably opens that location's kiosk, "Both locations" becomes "All locations" and nothing offers a choice at exactly one location, a member without a page's role gets a 404 instead of a raw 500, and the branding, notification and onboarding actions name the organization they act on. Found while verifying it in a real browser and **not fixed here**: every real kiosk check-in shows "1 / NaN" — the fourteenth "built it, never wired it" instance, launch-blocking. Revision 37 — B0: real students can reach the student portal. A self-registered, staff-approved student logged in to "No organization access" because nothing ever created their `STUDENT` membership; approval now does, archiving switches it off, and it can never overwrite or disable a staff membership held by the same person. The thirteenth "built it, never wired it" instance, and by user count the worst. Revision 36 — the student/staff account conflict reclassified from "will be hit at the first staff invitation" to **launch-blocking** (B4): in a jiu-jitsu academy every instructor is a student, and the second-email workaround makes the split permanent; the "built it, never wired it" tally extended to twelve. Revision 35 — staff management, Owner-only (`/admin/staff`): invite by email with a role and academies, edit, deactivate/reactivate *per organization*, resend/revoke invitations, and a copyable link; with the two defects it was blocked on fixed test-first — `acceptInvitation` overwrote an existing account's password, and deactivation was global (`User.active`), so removing someone from one organization locked them out of every organization they belong to. Revision 34 — payment plans become manageable (create, price, edit, deactivate — never delete), every organization prices in a currency (colones or dollars) and every payment carries the currency it was recorded in, and a newly approved academy starts with a monthly plan named in its own language; verifying as a registered owner in a real browser found one more bug that predates this revision (a payment saved with the method left on its default always failed). Revision 33 — verifying as a genuinely REGISTERED owner (register, approve, accept, log in) instead of a seeded account found two launch-blocking bugs invisible for five phases: every customer organization's owner was a `DIRECTOR` with no academies and could see nothing (fixed: approval grants `ADMIN`; the proposed ADMIN/DIRECTOR merge was cancelled — they are different roles, now labelled "Owner"/"Location director"), and the public registration form rejected every real browser submission since #24 (framework-injected `$ACTION_*` fields tripped `z.strictObject`; fixed, with a structural guard); the same verification showed no UI adds staff, assigns academies, or creates a second location, now launch-blocking checklist items. Revision 32 — SSL to the database decided and built (full verification against the provider's CA, supplied as a base64 env var, with a documented, self-announcing `no-verify` fallback that has an owner and an exit condition), after checking HOW TLS is actually configured on the `pg` driver-adapter path and finding it is neither where the connection string suggests nor where the Prisma CLI does it; and the "watch for it" first-deploy advice replaced by a runbook step that runs a real verification script (`pnpm verify:pooling`) before anyone uses the app. Revision 31 — the pooling fix revision 30 *described* is now actually implemented, and verification against the real driver-adapter path showed most of what revision 30 said about it was wrong: `?pgbouncer=true` is a Prisma-engine parameter and does nothing under `PrismaPg`; the real transaction-pooling hazard (named prepared statements) is avoided by construction and now pinned by a test; migrations go direct (`DIRECT_URL`, via `prisma7.config.ts`) because a pooled `migrate deploy` leaks its advisory lock and breaks the *next* deploy, not because DDL is unsupported; `max: 1` was bad advice; SSL to the pooler is an open decision. Revision 30 — the deployment gap named in the launch checklist closed: `docs/DEPLOYMENT_RUNBOOK.md` written, deciding the database/hosting provider Phase 0 deliberately left open (Vercel Pro + Supabase Pro, $45/month, chosen over a cheaper Railway-consolidated stack because `vercel.json` already exists and this pairing is the best-documented failure surface for the stack, not because it's cheapest — the tradeoff was made explicitly, not defaulted into); a real, unaddressed connection-pooling gap found in `src/lib/prisma/unscoped.ts` (no pooler awareness at all — fine for dev's single long-lived process, a textbook serverless-Postgres exhaustion risk in production); five more production-only failure modes named and ranked; README's own bootstrap section corrected after tracing a circularity in its previous version (register-then-approve has no path to the very first approver) that hadn't been caught until verified line-by-line against `approve-organization.ts`. Revision 29: found and fixed a pre-existing, already-shipped bug along the way (the director's own configurable brand color was the default data-series color on two existing charts, including `class-popularity-panel.tsx`, making a pale brand pick nearly invisible) by changing `BarList`'s own default rather than patching each call site; new fixed, non-brand-configurable `--data`/`--data-muted` tokens added with measured (not eyeballed) WCAG contrast ratios in both themes; the new chart shares its counting logic with `getClassPopularity` through two extracted helpers rather than a second query; a real gap found writing the operations doc (no panel button to resend an invitation for an ACTIVE organization) fixed in the same PR. Revision 28: Phase 7 re-scoped against what actually already existed (most of it, built continuously since Phase 1) rather than built to a stale checklist; `docs/MULTI_ACADEMY_OPERATIONS.md` written for Alexis as an operator, not an architecture summary; `docs/REDESIGN_BRIEF.md` audited and kept (implemented, cited by ~50 files, nothing to fold forward) rather than assumed stale; a launch checklist added naming every deliberately-deferred item with whether it blocks Alliance's own launch or only a future customer's. Revision 27: the timezone finding reframed and sized: not "a DST gap" but a single-timezone platform presenting itself as multi-tenant, with `Organization.timezone` a column no scheduling code reads; estimated at phase scale (core functions, context plumbing, 21 call sites, 19 test files, one real DST-edge-case design decision), not fixed yet — scheduled as a known-cost decision, not left to be discovered by a customer. Revision 26: Phase 6 billing shipped as its own PR; two bugs found only by live-browser verification (a bound-action form field silently rejected by `z.strictObject`, an off-by-one invoice deadline from a UTC/org-timezone mismatch); every `vitest.*.config.ts` now forces a deliberately hostile test-runner timezone so a test can no longer pass by agreeing with the machine it happens to run on. Revision 25: a dependency's own console output flagged, verified, and silenced as a prompt-injection surface, not because anything was actually injected that time. Revision 24: the real runtime backstop built and attached to the base client; see below for the actual blast radius this revealed. Revision 23: the Phase 1 "runtime backstop" claim corrected; it was never attached to the base client. Revision 22: the login/tenant-context conflation closed. Revision 21: repository-reviewed. Phases 1 and 2 supersede the first draft entirely; suspended-organization policy and platform billing (manual invoices, snapshotted grace, episode-scoped review) fully specified; branding moved to a first-login onboarding wizard; realistic belt rendering, student-page promotions, full sidebar palette, the attendance-by-class chart added; Phase 0 rebuilt around a clean dev database plus a deterministic seed, and the Phase 1 review decisions settled in Appendix C.

---

## What changed in revision 44 — logo upload/removal: the role gate, the error taxonomy, and a masked test fixture

**The role gate was narrower than the page around it, for no documented reason.** The branding settings page (`Configuración → Academia`) shows its theme AND logo controls to ADMIN and DIRECTOR alike — but `uploadBrandingLogo`/`removeBrandingLogo` enforced `["ADMIN"]` only, while `saveBrandingTheme` on the same page already enforced `["ADMIN", "DIRECTOR"]`. Reproduced directly: a genuinely registered (invited, accepted, real password) DIRECTOR uploading a real PNG hit `resolveActionContext`'s uncaught `Error("FORBIDDEN")`, which surfaces as this app's full-page crash boundary (`heading: "Something went wrong"`, digest number, no indication of what actually happened) — not a friendly inline refusal. Fixed by widening both actions to `["ADMIN", "DIRECTOR"]`, matching the page's own gate. The broader question of whether ADMIN/DIRECTOR should ever be merged stays parked, per the standing Owner/Location-director decision (revision 33) — this is a same-page consistency fix, not a re-opening of that question.

**A second, unrelated surface produces the exact same crash-screen wording, easily confused with the first from a screenshot alone.** Next's global `serverActions.bodySizeLimit` (`next.config.ts`, `"2mb"`) rejects an oversized request BEFORE any server action code runs, including uploadBrandingLogo's own graceful `tooLarge` check — reproduced by tampering a real File's `.size` property client-side (a stand-in for a scripted or modified-client request) to pass this app's own 512 KiB pre-check while sending real, larger bytes. The server logs `Error: Body exceeded 2mb limit. statusCode: 413`, but the browser receives a bare 500 and the same generic crash boundary as the FORBIDDEN case above — no size-related text reaches the user in either case. This is a framework-level rejection that happens before any server action's own return-value taxonomy exists to catch it; not fixed here (a different mechanism, arguably a different PR, and not requested).

**The three real numbers, verified rather than assumed:** the client pre-check (`logo-uploader.tsx`), the server rule (`logo-constraints.ts`), and the helper text agree exactly — 512 KiB (524,288 bytes), imported from one shared constant so they cannot drift. A file at that exact permitted maximum produces a real multipart request body of 524,440 bytes against the server action endpoint (measured via a `fetch` wrapper in a real browser session) — 152 bytes of multipart/action-reference overhead, comfortably inside the 2 MB cap with roughly 1.4 MB of headroom to spare. Not a boundary that only barely holds.

**Storage failures are now a classified, never-thrown result, never a crash.** `uploadLogo`/`deleteLogoByUrl` (`logo-storage.ts`) used to throw a bare `Error` (upload) or catch-and-log internally with no way for the caller to know (delete) — both now return a discriminated `{ok, ...}` result, classifying any non-2xx response or network/timeout failure by HTTP status the same way `src/lib/kiosk/offline-queue.ts` already classifies its own external responses (401/403 → `permissionDenied`, 404 → `bucketMissing`, 429 → `storageRateLimited`, everything else including a network failure or a 15s timeout → `storageUnavailable`). User-facing copy deliberately collapses three of these into one shared message with a short stable support code appended (`"...Contact an administrator. (LOGO-PERM)"` / `(LOGO-BUCKET)`) — to the person at the screen these all mean the same thing (not their fault, not fixable by picking a different image), but the code turns a support message ("it says there's a problem with logo storage") into a diagnosis without needing the server log, which may already be rotated. `storageUnavailable` gets its own actionable copy ("try again shortly") since it may be transient; `storageRateLimited` gets its own actionable copy with no code, since retrying later is the correct action regardless of which underlying cause it was. The full classification, organization id, and HTTP status are still logged server-side in every case.

**Correction, found by review before this PR merged: the "never throws" claim above was not yet true.** `storageBase()`/`authHeaders()` (both call `requireEnv`) were evaluated as arguments to `storageFetch` — outside its own `try` — so a missing or invalid `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` still threw straight out of `uploadLogo` and, worse, out of `deleteLogoByUrl` called AFTER a removal's database write had already committed — turning an already-successful removal into the exact crash screen this whole revision exists to prevent. Fixed by moving request construction inside `storageFetch`'s own `try` (a `buildRequest` callback invoked there, not before), so a configuration failure is now indistinguishable from any other unreachable-storage case: a classified `storageUnavailable` result, never a throw. Covered by dedicated missing-`SUPABASE_URL`/missing-`SUPABASE_SERVICE_ROLE_KEY` tests for both `uploadLogo` and `deleteLogoByUrl`. The "never throws" claim is accurate as of this fix, not before it.

**Correction, same review: classification by HTTP status alone mislabeled two real Supabase Storage error codes.** Checked against Supabase's own documented error codes (supabase.com/docs/guides/storage/debugging/error-codes): `TenantNotFound` and `NoSuchBucket` both return 404 but mean very different things — one is a provisioning problem to escalate, the other is a bucket to (re)create — and status-only classification called both `bucketMissing`. Separately, `SlowDown` (503) is Supabase's own rate-limit signal, the same meaning as 429, but status-only classification lumped it in with a generic `storageUnavailable`. Fixed by parsing the response body's own `{code, message}` shape first (matching against a small table of the codes this module's two operations can realistically produce), falling back to the existing status-only classification when the body is missing, malformed, non-JSON, or carries a code this module doesn't recognize — so an as-yet-undocumented or future Supabase error code degrades to a reasonable guess rather than a crash or a silent misclassification. The raw provider `code`/`message` are now carried through into the server-side log at every call site (never into user-facing copy, which stays exactly as designed above) — turning "it says LOGO-PERM" into a diagnosis that also names the exact thing Supabase itself said was wrong.

**Confirmed against the real dev Supabase project** (not assumed from `.env` entries existing): the storage endpoint is reachable, the `org-branding` bucket exists and is genuinely public, and the service-role key is valid — verified with three read-only HTTP calls, credentials redacted from all output. Separately verified against the real bucket, not merely a mocked test: a real upload followed by a real removal (as a real ADMIN session) leaves the DB `logoUrl` null and zero objects in the bucket under that organization's prefix; a real replace (upload, then upload again) leaves exactly one object in the bucket — the old object is deleted after the new row commits, never orphaned in the success path.

**Removal's two failure modes are distinct, and only one of them is a real defect.** The database write clearing `logoUrl` and the storage cleanup that follows it are separate steps that already ran in the correct order (reference cleared and committed first, cleanup attempted after) — a genuine DB failure during the update surfaces as this app's ordinary uncaught-exception crash screen, consistent with every other action in this codebase that doesn't wrap its own `$transaction` in a try/catch (not a regression to fix here). A storage-cleanup failure AFTER that commit, however, used to be silently swallowed with no context an operator could act on (`deleteLogoByUrl` logged internally, with no organization id, and both call sites discarded the outcome entirely). Fixed: `deleteLogoByUrl` now returns the same classified result `uploadLogo` does (never just a boolean — the error category, HTTP status, and Supabase's own provider code/message when it failed), and both call sites (replace, remove) log a `console.error` with the organization id, the orphaned URL, and that full classification, while still reporting the upload/removal itself as successful — the director's request already succeeded; an orphaned object is the platform's own debris to clean up, never the user's problem. **Known, accepted limitation, not fixed here:** a cleanup failure at either call site still leaves exactly one orphaned object with no retry or reconciliation job — across many organizations replacing logos over time, a bucket with zero garbage-collection will accumulate some.

**A masked-fixture defect, the same shape this doc already tracks under "masked by an overlapping layer" for guards — this time in a test.** `tests/integration/branding-actions.test.ts`'s `"REQUIRED: a director can remove a logo, returning to the initials fallback"` had, since it was written, instantiated an ADMIN (`makeStaffUser("ADMIN", ...)`) despite its own title — it asserted the remove action works, which was true, but proved nothing whatsoever about directors. It passed for five phases because the ADMIN-only gate this revision just widened made an ADMIN fixture and a DIRECTOR fixture behave identically for every OTHER assertion in that test. Fixed by using the role the title actually names. Logged here alongside the guard-side instances (revision 41) rather than folded into the "built it, never wired it" tally: nothing here was unwired or dead code — the fixture ran, and the assertions it made were all true — it simply never tested what its own name claimed to.

**Verified in a real browser as a genuinely registered DIRECTOR** (invited via the real staff-invite flow, accepted via the real invitation-acceptance flow — never a seeded account): the FORBIDDEN crash reproduced before this fix; after it, the same DIRECTOR session uploads a real PNG, sees it rendered from the real Supabase-hosted URL in both the branding page and the sidebar after a full reload, replaces it, and removes it back to the initials fallback — all confirmed against the real bucket and the real database row, not only against a mocked integration test.

---

## What changed in revision 43 — C2 and Sentry: designed, approved, deliberately deferred

**Not a gap. A decision, and it belongs on the record the same way a shipped phase does — so a later session never mistakes deferred for forgotten.**

**C2 — the `/platform` observability views.** Design proposed and approved: a signups-over-time chart on the platform overview (same shape as the existing weekly attendance trend); a cross-org billing page aggregating `OrganizationInvoice` across every organization (read-only — the actions stay where they already are, on each organization's own detail page); a global audit viewer (the one place `resolveOrganizationAuditTrail`'s org-scoped sibling doesn't reach), with two new indexes already scoped for it (`AuditLog`'s `createdAt` and `action` — the existing `actorId` index is enough for actor-filtering at today's table size; no composite index until real data says otherwise); and a `JobRun` history viewer (write-only since C1). Confirmed in the same conversation: **per-organization detail, per-org billing, and the per-org audit trail already exist** (Phase 6) — C2 does not rebuild them. An earlier, B4-era note about a "student drill-down" logged in an organization's audit trail is explicitly **not** in this design — it gets added when a real support case demands it, not built on spec.

**Why deferred, in the user's own words:** "all four pages display data that doesn't exist. Cross-org billing across one organization. Signups over time from one signup. A global audit viewer over a few dozen dev rows. Job history with two runs from a local stub. Building them now means verifying them against fixtures and synthetic organizations — which is exactly the mode that produced fourteen bugs over the last two weeks, every one of them passing against a constructed world while the real path was broken. And after a month of actually running Alliance I'll know which of those pages I keep wanting and can't have. That's a better specification for them than either of us can write today."

**Sentry — same treatment, same reason.** Locked-down `dataCollection` plus a synthetic-PII scrubber test, as its own PR. Deferred because it is, in the user's words, "more useful pointed at an environment where real errors can happen" — dev/CI has no real error population to prove a scrubber against.

**Neither blocks anything.** Both are approved to build whenever the user asks — this section is the spec they'll be built against when that happens, not a re-proposal.

---

**Where the project actually stands, stated plainly.** The engineering that blocks Alliance's own launch is complete. What remains is not code: a product name, a domain, a Supabase project, a Vercel project, the deploy itself, the bootstrap sequence, and terms of service — all the user's own next steps, none of them requiring anything further from this doc's own build process. The next session's task, whenever it comes, is either those steps or something breaking during them.

---

## What changed in revision 42 — C1: the crons can no longer fail silently

**The problem, named back in revision 30 and left as a known production-only risk.** `docs/DEPLOYMENT_RUNBOOK.md`'s own list of production-only failure modes named "the digest cron silently never firing on the wrong Vercel environment scope" — and separately, `dispatchNotification` returned `void` and only *logged* a failed send, so a digest where every single email failed (exactly what happens today, with no verified Resend sending domain) still reported `ok: true` to whatever was watching. Nothing watched anyway: there was no health endpoint, no run history, no alert. This closes both halves.

**Real counts, out of the dispatcher.** `dispatchNotification`/`dispatchToRecipients` (`src/lib/notifications/dispatch.ts`) now return `{ attempted, sent, failed }` instead of `void` — a thrown channel and a `{success:false}` channel both count as failed; every existing caller that discarded the return still compiles unchanged. `sendWeeklyDigestForAcademy` (`src/lib/notifications/weekly-digest.ts`) surfaces `{ organizationId, sent, failed, skipped }`: zero staff recipients on file, or the organization going non-`ACTIVE` between the cron's own dispatch loop and this call, is a **skip**, never a failure — a real absence of anyone to notify is not the same problem as an email that was attempted and bounced, and must never trip the dead-man's switch on its own.

**`JobRun`: one row per invocation, platform-level (no `organizationId`), never in `tenant-guard.ts`'s `TENANT_SCOPED_MODELS`.** Status (`RUNNING`/`SUCCEEDED`/`PARTIAL`/`FAILED`), start/finish times, `sent`/`failed`/`skipped`/`organizationsProcessed`, a capped per-organization breakdown (ids and counts only — this table has no tenant scope at all, so nothing more identifying belongs on it), a truncated error summary, and the heartbeat ping's own outcome. This is `JobRun`'s **own** state — nothing reads `AuditLog` to know when a job last ran or how it went, the same rule `Student.statusBeforeArchive` follows: an audit log records what happened and must never be what a code path depends on.

**`runScheduledJob` (`src/lib/jobs/run-scheduled-job.ts`)** is the one thing both cron routes go through now: checks `CRON_SECRET`, writes a `RUNNING` row, runs the job (the route itself still builds its own JSON response, so the two routes' existing shapes are preserved and only gain new fields), finalizes the row, then pings Healthchecks.io. **The ordering is deliberate, not incidental, and is written as a comment in the code so nobody "fixes" it**: the `JobRun` row is finalized *before* the ping, never after. If the function is killed between the two (a Vercel execution timeout, a cold-start eviction), the row is left reading its real final status but no ping ever reaches Healthchecks — which alerts on the missed check-in once its grace period elapses. That is a **false alarm**, not silence, and a false alarm is the correct failure direction for a dead-man's switch: a human checking it finds a `JobRun` row that already says what happened. The reverse order would let the same kill leave a recorded *success* ping for a run whose own row never finished — silencing the one signal meant to catch exactly that. A real, injected-DB test (not just a code read) proves the row is already committed in the database at the moment the ping fires, by having the (mocked) ping itself query a **separate** Prisma client mid-flight.

**Healthchecks.io (`src/lib/jobs/heartbeat.ts`).** A GET to the job's own configured URL means success; `<url>/fail` means failure — Healthchecks.io's own convention, and the dead-man's half of the switch: a **missed** ping (the schedule's own period plus a grace window, configured on Healthchecks.io's side) alerts on its own, independent of whether the app ever tried to ping at all. **Decision #1 (approved): any `failed > 0` pings `/fail`** — at Alliance's volume, one failed email is signal, not noise; there is no ratio threshold. A 5-second `AbortController` timeout keeps a hung Healthchecks request from ever extending the job itself. No configured URL — the real state today, since no Healthchecks.io account exists yet — is reported honestly as `"not_configured"`, never silently folded into `"ok"`.

**Two health endpoints, deliberately split by audience (decision #3).**
- **`GET /api/health`** — public, unauthenticated, database-only (`SELECT 1` via `unscopedPrisma`, since a liveness ping has no tenant to scope it to). **Cached for 5 seconds** (`src/lib/health/database-check.ts`): being public and unauthenticated means anyone who finds the URL can poll it, so the cache caps that at one real query per window regardless of concurrent callers, while staying short enough that a monitor polling every few minutes never sees a stale result and a genuine outage or recovery is visible almost immediately. A failed check is cached too, so an outage doesn't turn into repeated real queries either.
- **`GET /api/health/jobs`** — behind the same `CRON_SECRET` the crons themselves use (decision #3: "job freshness behind the secret"; this names real organization-touching activity, so it is never public). Per job: the last `JobRun`, whether it's **stale** (older than that job's own expected cadence — 8 days for the weekly digest, 30 hours for the daily promotion job — plus slack; a second, independent signal alongside the Healthchecks.io heartbeat, not a replacement for it) and whether it's **stuck** (a `RUNNING` row older than 30 minutes that never finished — almost certainly a crashed invocation). A job that has never run at all is reported the same as one gone quiet: `lastRun: null`, `stale: true`.

**`JobRun` is write-only in C1 (decision #4)** — no platform UI reads it yet; that comes with C2. `/api/health/jobs` is the only reader for now.

**A real test-isolation gap, found and fixed while mutation-testing, disclosed as its own pattern.** The digest cron route's per-academy `catch` block increments a coarse `failed` tally (documented as deliberately mixed-unit: "did anything fail," not a precise cross-unit metric) — mutation-testing that specific increment away should have failed a test and didn't, because the existing "one academy's failure doesn't block others" test never protected the real seeded academies (Escazú, Escalante) from also being processed for real, and a coincidental real Resend failure against them (no verified sending domain, same root cause as the launch checklist's own Resend item) already made `failed > 0` regardless of my mutation — a real failure masking whether a *specific* line of code mattered, the same shape of finding as revision 41's "masked by an overlapping layer," here in a test rather than in production code. Fixed by protecting those academies the same way the sibling "processes real academies" test already does, plus a `body.failed` assertion — the mutant is now caught. **Mutation testing earned its keep here**: nothing else would have found it — the test read as green, asserted the right thing, and still wasn't testing what it claimed to. A test whose pass depends on ambient real-world state (a real delivery failure, a real pre-existing row) rather than on the deliberate behavior under test is the test-layer version of the same "masked by an overlapping layer" pattern.

**Tests, first, red for the right reasons.** Unit 545, integration 711 — twice, back to back, to rule out flakiness — smoke unchanged (C1 has no user-facing UI), all green; lint at the 23-warning baseline with no errors; guard-usage 47 (C1's new modules live under `src/lib/jobs`/`src/lib/health`, outside that check's scope); the parity check matches; the production build passes with all four new routes registered. **Nineteen mutations, each caught**, across the heartbeat module (success/fail URL selection, response-status handling, the catch-swallows-as-ok path, the missing-config check, timeout handling), the scheduled-job wrapper (status derivation for `SUCCEEDED`/`PARTIAL`/`FAILED`, and — the one the user asked to be pinned by test, not just by comment — the finalize-then-ping ordering itself), the database-health cache (window enable/disable/expiry, the swallow-as-success path), the digest's skip semantics (zero recipients, non-active organization), both cron routes' `ok`/`failed` aggregation, and the jobs-health route's stale/stuck/secret checks.

**Verified over real HTTP** against a running dev server and a local stub standing in for Healthchecks.io (no real account exists yet): `GET /api/health` with no header returns `{ok:true}`; `GET /api/health/jobs` 401s with no or a wrong secret and, with it, reports both jobs `stale: true, lastRun: null` before either has ever run; invoking both real cron routes end to end showed the digest's actual state honestly — `sent: 0, failed: 5` (every email failed, the real, disclosed Resend-sandbox limitation, not masked as `ok: true`) — while the promotion job (Alliance's own seed has `requiresCoachApproval: true`, a structural no-op there) reported a clean `SUCCEEDED`; `/api/health/jobs` then showed both fresh `JobRun` rows with the matching real counts, and the local stub's own log confirmed the digest run pinged `/digest/fail` while the promotion run pinged the plain `/promotion` URL — the heartbeat correctly distinguishing the two outcomes. The two `JobRun` rows this created in the **dev** database — the first two real system-telemetry rows this table ever held — were cleared after review, back to the established convention (seeded Alliance data only): they were real, not synthetic, but a verification artifact is still debris once its job is done, and two rows recording a failed digest is exactly the kind of thing that reads as a live finding to whoever looks at the table next.

**Not verified.** No real Healthchecks.io account exists — the setup steps are documented in `docs/DEPLOYMENT_RUNBOOK.md` ("Set up the Healthchecks.io dead-man's switch") for Alexis to do at deploy time, with the exact cron schedules and the grace periods (6 hours for the digest, 3 for the daily promotion job) already decided and written down, not left as a TODO. Nothing here ran against a production deployment (none exists); `pnpm build` passes but a production server was not driven. A real Resend delivery, and therefore a genuinely `sent > 0` digest run, was not exercised — the same disclosed limitation every prior phase's verification has run into.

---

## What changed in revision 41 — a tenant gate can no longer be permissive by omission (and three small fixes revision 40 left behind)

**The finding revision 40 made, and why it is recorded as its own pattern.** `requireTenantContext()` with **no role list admitted any membership — students included.** The dashboard, roster, payments and student-detail pages called it that way, and nobody could see it, because the Edge middleware happened to be refusing the same people on a different basis (the global `User.role`). The hole existed *because two layers overlapped*: each was quietly relying on the other, so neither was ever checked alone. It only became reachable when one layer was removed (B4 replaced the role gate with a claim the middleware can only *refuse* on) and a feature arrived that left a student-only person holding a stale staff claim ("Student only"). This is a **new variant of the project's recurring pattern**, distinct from "built it, never wired it" (a function nobody called): **a guard that holds only because another layer happens to cover for it — "masked by an overlapping layer."** It is counted separately, so **the "built it, never wired it" tally stays at fourteen.** Two instances so far, both found by trying to make the layer underneath fail: `requireTenantContext()` (revision 40) and `regenerateStudentCode` (below).

**The fix in revision 40 pointed the default the safe way. That was not enough:** a footgun that happens to point safely is still a footgun. So the no-role-list form is now **impossible**, the same principle as making `unscopedPrisma` the loud import:

- **The role-list parameter is required** in both tenant gates — `requireTenantContext(allowedRoles)` for pages and `resolveActionContext(organizationId, allowedRoles)` for server actions. Leaving it out is a compile error.
- **Every production call passes an explicit array literal of role names** — not a constant that could be reassigned or emptied, not `undefined`, not a spread, not `[]`. `tests/unit/tenant-gate-has-no-default.test.ts` enforces it with positive controls for each bad form. Six calls that spread a module constant (`[...STAFF_ROLES]`, `[...STAFF]`) became literals and the constants were deleted.
- **Naming `STUDENT` in a gate is how a page or action admits students**, so only the portal gate (`requirePortalContext`, in `context.ts`) and the self check-in action may.
- **`requireOrganizationAccess`** (the optional-roles primitive under `resolveActionContext`, which ten tests use to build a context) is called by nothing in production but `context.ts`, so it can never be a gate by omission. The test pins that too.
- **The sibling was audited, and it had the same shape.** `regenerateStudentCode` called `resolveActionContext(organizationId)` with no role list, under a comment that said "any staff role" while the code admitted any role at all. **It was not exploitable**: a student-only member got `notFound`, because the academy-scope check that follows happens to refuse them (their context has no academies) — the second layer covering for the first, exactly the pattern above. It now names `ADMIN`, `DIRECTOR`, `INSTRUCTOR`, and a real-path test proves a student-only member is refused by the *role* gate (`FORBIDDEN`, not `notFound`), that an assigned instructor still can, and that the code is unchanged. The `FORBIDDEN` throw for a genuine member with the wrong role is the long-standing behavior of `resolveActionContext`; it was not changed.

**Three small fixes, from revision 40's "observed, not changed".**

1. **Demoted while logged in no longer dead-ends at a bare 404.** Revision 40 solved the promoted direction with the refresh route; this is the same situation reversed. A member who is *not staff at all* and reaches a page whose role list excludes students (a stale or forged staff claim) is now redirected to `/api/access/refresh`, which corrects the claim from the database and lands them on the no-access page — "Your account doesn't include this part of the app", with **Go to my training** and **Sign out**. A *staff* member refused an Owner-only page still gets the 404: they know the app exists, and that is the "disclose to members, never to non-members" rule for `/platform`-style routes. The redirect carries the request's locale in `to`; `to` is never somewhere the person is then sent.
2. **The status badge no longer reads Pending after "Student approved."** The cause was general: none of the state-changing student actions told Next the page was stale, so a server action's response never re-rendered the page it was called from — and the Approve button stayed to be clicked twice. Approve, archive, restore and edit now revalidate the student's page and the roster (best-effort: a failure to revalidate is logged and never turns a committed change into a reported failure). One visible consequence, noted rather than hidden: the "Student approved." line disappears with the button it lived in; the badge changing is the confirmation.
3. **The join page stops telling a signed-in person to sign in.** After an existing account joins, the page said "Sign in with the password you already have" to everyone. The server now says whether the visitor's *own session* is the invitee's (`alreadySignedIn`, decided next to the invitation so the email never goes to the page); that visitor sees "You are already signed in. Open the app to get started." with a link to the app (their next click refreshes their access from the database); everyone else still sees the sign-in instruction. A test drives the real page so a correct function cannot sit unwired.

**Tests, first, red for the right reasons.** Unit 532, integration 693, smoke 21 (all through a running server), all green; lint at the 23-warning baseline with no errors; guard-usage 47; the parity check matches; the production build passes. The smoke suite now proves the demoted redirect over real HTTP and that following it heals the session so the very next request is refused at the middleware. **Mutation-tested**, each caught: either gate's parameter made optional again; a page or action passing `STUDENT`, an empty list or no list; the demoted redirect replaced by the old 404 (in-process and over HTTP); an action with no revalidation of the detail page, the roster, or with revalidation allowed to fail the action; the join flag always true, case-sensitive, or never passed by the page; the form ignoring it for the copy or the link; `regenerateStudentCode` admitting students or locking instructors out; production code calling `requireOrganizationAccess` directly. One mistake of mine, disclosed: a doc comment containing a literal `*/` in a test helper ended the comment early and turned the rest of the sentence into stray code that happened to parse — lint caught it as a 24th warning and it was fixed, not baselined.

**Verified in a real browser** as a freshly registered Owner and a student who signed up through the public form, in two isolated browsers with both sessions live: approving the pending student flips the badge to Active and removes the Approve button with no reload; the Owner invites the (already signed-in) student as Instructor and the student, joining from the browser they were already signed in on, sees "You are already signed in. Open the app to get started." and one click lands on the dashboard with the Instructor nav; the Owner then moves them to Student only, and the student's still-open staff session, sent to `/en/students`, lands on the no-access page with "Go to my training" and "Sign out", and the link goes to the portal. All of it cleared afterwards (zero organizations and users remain); screenshots in the untracked `.review-shots/`.

**Observed, not changed.** (1) `students/[id]/page.tsx` still has a `STUDENT`-role branch that can no longer be reached (its role list excludes students); harmless defence in depth, and `selfStudentId` has almost no other consumer — worth a cleanup, not folded in here. (2) Six integration tests now carry their own copy of the register → approve → accept → sign-up world builder; it should be one shared helper. (3) The signed-out variant of the join page (the old sign-in copy) is covered by a unit test, not by eye in a browser.

**Not verified.** Nothing ran against a deployment (none exists); the middleware, refresh route and redirects were exercised under `next dev`, with `pnpm build` passing. Spanish copy was checked by the message-parity test and a unit test, not by eye in a browser. Invitation email delivery was not exercised (the development Resend key is invalid), so the copyable link was used.

---

## What changed in revision 40 — B4: access is membership, not the global role

**The problem (found in revision 35, made a blocker in revision 36).** The middleware gated whole route trees on the global `User.role` in the session, so one account could not be both a student (`/portal`) and staff (`/dashboard`), and inviting a student's address was refused (`studentAccount`). In a jiu-jitsu academy every instructor is a student, so that refusal was hit at every staff invitation and the workaround — a second email — split the people who use the app most across two identities.

**The decision: access is the MEMBERSHIP, plus a linked student record for the portal.** The session carries a claim `access = { staff, portal }`, derived from the database for the *active organization* at sign-in and again on any session update (`unstable_update`, which is how an organization switch already worked). `staff` means an active membership as Owner, Location director or Instructor; `portal` means an active membership **and** a linked `Student` whose status is `ACTIVE` (consistent with B5 — an archived or pending student has no portal). Both are computed by the same rule the per-request check uses (`resolveContext` → `accessFromMembership`), so the claim can never disagree with a page about what a membership means. `TenantContext` gains `linkedStudentId`, deliberately separate from `selfStudentId`, which stays STUDENT-role-gated and keeps driving roster scoping.

**The claim is a hint, never a grant.** The Edge middleware has no database, so `routeAccess(path, hasSession, access)` (pure, in `src/lib/auth/route-access.ts`) can only *refuse*: no session → login; a missing or malformed claim → login (**fail closed** — a token from before the claim existed re-authenticates; it is not quietly upgraded); a well-formed claim that denies the tree → `refresh`. Trees are matched on whole path segments (`/dashboard`, `/students`, `/admin` are staff; `/portal` is portal). Every page then re-derives access from the database, and that check is the only thing that stops a claim that says more than the database does.

**The other direction, decided rather than discovered.** "Anny promotes a student to instructor while they are logged in" — their token still says portal-only. A refusal there would be silent, and "log out and back in" is not an answer we give a customer. So `refresh` sends the request to `/api/access/refresh?to=<path>` (a Node route, excluded from the middleware matcher so it can never loop back through the gate). It re-derives access with `getTenantContext`; if the database disagrees with the claim **in either direction** it rewrites the claim (`unstable_update`); if the fresh access now allows `to` it continues there, and otherwise shows `/no-access` — a plain page saying the account does not include this area, with a link to where the person can go and a sign-out, never the login page. `to` is a client-controlled string and only ever followed through `sanitizeCallbackUrl`. A claim-less session is *not* healed by this route; it goes to login. A demoted person holding a stale staff claim is not routed through the refresh at all (the middleware has nothing to refuse); they get the page's own 404 until they next sign in, which is the safe direction.

**Promotion in place, demotion by "Student only".** Accepting a staff invitation on an address that is already an ACTIVE student membership changes that same membership row to the invited role — same login, same password, same student record — and assigns the academies, with an audit row `staff.promote` carrying before `{ role: "STUDENT", academyIds: [] }` and after `{ role, academyIds }`. It is the only change an invitation can make to an existing membership: anyone already staff, or deactivated since the link was issued, is left exactly as they are. The edit form offers **Student only** (never on the invite form): it needs an ACTIVE linked student record (`noStudentRecord` otherwise), clears academy assignments, and inherits the self-change, last-Owner and Owner-only guards. Sign-in lands by access (`/dashboard` for staff, `/portal` for a student-only member), not by the global role. The staff menu shows **My training** and the portal menu shows **Staff** only when the database-resolved context says the person has that side; both props are required, so an unwired caller is a compile error, and a structural test pins that they are passed from `accessFromContext(context)` and never a literal or the session claim.

**`User.role` is made loud, not merely unused.** The column stays (it is written at account creation), but nothing authorizes on it. The schema carries a `///` comment on the column saying it is not an authorization source and naming what is; `tests/unit/user-role-is-not-authorization.test.ts` fails if any file under `src`, `scripts` or `prisma` reads it (`user.role`, `token.role`, `session.user.role`, a `select: { role: true }` on a user query), with an explicit allowlist — one entry, `scripts/db-inventory.ts`, an inventory report that decides nothing — and positive controls, the same shape as the `unscopedPrisma` rule. Removed as dead: the portal's PENDING/INACTIVE status notice (the portal now serves only ACTIVE students) and both `studentAccount` refusals (invite and accept).

**Found while writing the stale-claim tests, and fixed in the same PR.** `requireTenantContext()` called with **no role list admitted any membership, including `STUDENT`**. The dashboard, roster and payments pages call it that way, so a student-only member whose token still claimed staff access (stale after "Student only", or forged) was passed by the middleware — which can only refuse — and then *not* stopped by the page, the one check that can be. The old `User.role` middleware had been hiding it. Reached in practice by exactly the new feature: demote an Instructor to Student only, and their open session keeps a staff claim. The fix is at the root: no role list now means staff roles; the portal names all four explicitly (`requirePortalContext`). This is a different failure from "built it, never wired it" (a check that held only because another layer did, not a function nobody called), so **the tally stays at fourteen** — say so if you would count it.

**Tests, first, red for the right reasons.** Unit 515, integration 675, smoke 19, all green; lint at the 23-warning baseline with no errors; guard-usage 47; the parity check matches; the production build passes. The stale-claim test drives **both halves**: `tests/integration/forged-claim-server-components.test.ts` renders the real default export of each staff page (dashboard, roster, payments, staff, locations) for a student-only member — registered, approved, the whole real path — whose session claims staff, and requires exactly a 404 (with a positive control that the real Owner passes the same pages); `tests/smoke/stale-access-claim.test.ts` does it over real HTTP through a running server and the real middleware: an honest student is refused *at the middleware*, the same student with a forged staff claim sails through it and gets a **404 from the page**, a promoted-while-logged-in token goes middleware → refresh → **cookie rewritten** → the dashboard renders (no loop), a claim-less token fails closed to login and is not healed, and `to` is never an open redirect. The smoke suites' localhost guard and session minting now live once in `tests/helpers/smoke.ts`.

**Mutation-tested.** Caught: the page gate's default reverted (in-process *and* over HTTP); the refresh never rewriting the session; a refused person sent to login instead of told; a claim-less token healed; `to` unsanitized; a denying claim sent to login instead of the refresh (smoke and unit); the menu links always shown, always hidden, pointing at the wrong place, or wired to a literal or the wrong field; and the earlier commits' mutations (claim derivation, the promotion and demotion guards, the `User.role` scan). One mutation was **equivalent** (no observable difference) and is documented as such rather than counted as a gap. One mutant of mine was invalid (a shell mangled the comment I substituted into a syntax error) and was redone properly rather than counted.

**Verified in a real browser** as a freshly registered Owner (register, approve by CLI, accept) with a student who signed up through the public form and was approved, in two separate browsers so both sessions were live at once: the student lands on `/portal` and their menu offers only Sign out; sent to `/dashboard` they get the plain no-access page with a way back to their training; the Owner's menu offers no My training (no student record); the Owner invites the student as Instructor and the student joins with their existing password; **with the old portal-only session still open**, the portal now shows Staff, one click goes through the refresh and lands on the dashboard with the Instructor nav (no Owner-only entries) — no login screen, no logout; the staff menu shows My training and it goes to the portal; the Owner edits them to Student only (the location choice disappears and the hint says what is lost) and saves; the student's still-open staff session gets a 404 on `/students` and the portal shows no Staff. The audit trail read back as designed: `staff.invite`, `staff.promote` (before STUDENT, after INSTRUCTOR with the academy), `staff.accept` (`promoted: true`), `staff.update` (before INSTRUCTOR, after STUDENT). All of it was cleared afterwards (zero organizations and users remain); screenshots are in the untracked `.review-shots/`.

**Observed, not changed.** (1) After accepting an invitation on an existing account the page says "Sign in with the password you already have", which is aimed at someone who is not signed in — a person already signed in in another tab reads it oddly; it is not wrong, and B4 did not touch it. (2) On the student page, right after "Student approved." the status badge still read Pending until a reload; not investigated. (3) A demoted person sees the generic 404 rather than the no-access page until they next sign in (above) — safe, and by design.

**Not verified.** Nothing here ran against a deployment (none exists). The middleware, the refresh route and the cookie round trip were exercised under `next dev`, not a production server; `pnpm build` passes. The Spanish copy was checked by the message-parity test, not by eye in a browser. Email delivery of the invitation was not exercised (the development Resend key is invalid), so the copyable link was used, as designed.

---

## What changed in revision 39 — B5: restoring a student, the awaiting-approval notice, and the kiosk fix

**The kiosk "NaN" (#47) — fixed.** The check-in screen read `remainingToNextStripe` / `examEligible`; the API returns `remainingAttendance` / `isEligible`. The client's `summary` type is now a `Pick` of the server's `AtBeltSummary`, so a rename on the server is a compile error instead of a wall-mounted "NaN", and the screen reads the real names with the conditions the portal already used. Tests render the success screen from fixtures `satisfies`-checked against that type (mid-belt, one to go, stripe-eligible, exam-eligible, terminal belt) plus a structural test that the client declares no summary fields of its own; three mutations each fail one. In a real browser the screen now reads "1 / 30" and "29 attendances to go for your next stripe". It was the fourteenth "built it, never wired it" instance and the last launch blocker other than the Resend domain and B4.

**B5 — restoring an archived student.** Until now nothing could reverse an archive, though the dialog said "This can be reversed by editing status later" and `status` is not editable. An ARCHIVED student can now be restored (ADMIN or DIRECTOR, in scope). It returns them to the status they had, and their membership follows: only a student restored to ACTIVE or INACTIVE — someone who had been approved — gets their `STUDENT` membership back, through `grantStudentMembership` (which never overwrites a staff role); a student restored to PENDING gets none, exactly as before they were archived. Only an ARCHIVED student can be restored, and that precondition is re-asserted in the update's own WHERE, so concurrent restores count once. Archiving an already-archived student is now a quiet no-op, because writing again would overwrite what restore needs. Every restore is audited (`student.restore`, with `fromStoredStatus`).

**The decision: store it, do not derive it.** "The status they had" is a nullable `Student.statusBeforeArchive`, set when a student is archived, read when they are restored and cleared afterwards. It is **not** read from the `student.archive` audit row, although that row holds the same fact. **An audit log records what happened; it must never be what a code path depends on to function.** Audit rows get pruned, rotated and exported, and the day someone trims rows older than a year, a restore that read them would start doing the wrong thing with no error. A test deletes every audit row and restores anyway. This is the third application in this codebase of "store what you will need later" over "derive it from something else" — after the currency snapshot on `PaymentPeriod` (revision 34) and `PromotionCredit.beltAwardedAtAnchor` — and the pattern is worth naming as one: when a later action needs a fact about the moment of an earlier one, capture it on the row at that moment.

The alternative considered was always restoring to ACTIVE. Its "approval bypass" is not one — anyone who can archive a pending applicant can approve them — but it is a surprising side effect, and storing the status preserves the right behaviour instead of making the wrong one harmless. An applicant archived while PENDING comes back PENDING, with no membership, and approval still works afterwards.

**The null case, chosen rather than discovered.** A student archived *before* the column existed has nothing stored. **Restore sends them to PENDING**, never guessing "approved". The two possible mistakes are not symmetric: a wrong PENDING shows up in the awaiting-approval queue, one click from ACTIVE, whereas a wrong ACTIVE silently gives a rejected applicant a roster place and portal access with no prompt to anyone. Their audit row records `fromStoredStatus: false`, so the case is visible afterwards. There are no such students in production (nothing is deployed); the case exists for development data and anything archived before this migration, and it costs one extra click.

**Copy.** The archive dialog now says "You can restore them later" (in Spanish, "Podés restaurarlo más adelante"), which is true, and the Restore confirmation says what comes back. `/no-organization-access` tells a user whose *own* `Student` record is PENDING that their registration at the academy is **awaiting approval**, instead of the generic "your account isn't linked to any organization" that reads as an error — driven by `resolvePendingApplication(userId)`, which returns nothing about anyone else and nothing once the application is approved, archived, or was never a student.

Tests first, red for the right reasons: sign up → approve → archive → restore → the portal works again, through the real public form and the real actions; PENDING-before-archive; the null case; a student with no account; a director restricted to their own location (out of scope is `notFound`), an instructor refused (`FORBIDDEN`), a non-member told `notFound`, the two-tab case; a coach who also trains keeps their staff role; concurrent restores restore once; the audit-log-independence test above. Nine mutations, each failing a test. Suites: unit 468 → 475, integration 607 → 622; the parity check passes with the additive migration.

**Verified in a real browser** as a freshly registered Owner, with two students signed up through the public form: the archive dialog reads the new copy; an archived student's page offers only "Restore student" and the Restore dialog says what comes back; an approved student, archived and restored, is **Active again and back in their portal** ("Hi, Sofia!"); one archived while pending is restored **Pending** with "Approve student" still available; while archived, the student's login shows the generic message (archived is not pending), and while pending it shows **"Awaiting approval — Your registration at Verify B5 is awaiting approval…"**. Verification data was deleted afterwards and none remains.

**Observed, not changed.** After `pnpm build`, `pnpm dev` can fail every page with a Turbopack `next/font/google` "Module not found" until the gitignored `.next` directory is deleted — stale build output, not application code. Restore is one student at a time (no bulk restore), and `INACTIVE` — which nothing in the product sets — restores to itself with its membership, as the code treats it like ACTIVE.

---

## What changed in revision 38 — B3: adding a location

**The finding it closes.** Revision 33 registered Alliance through the real flow and got one academy, named after the city: `academy.create` ran only in `approveOrganization` and in the seed. Alliance has two locations and there was no page to add the second — so the first customer could not be set up.

**What was built**, as four commits with their tests first:

1. **Seven "use server" functions moved to the explicit-organization primitive.** My proposal called this "four action files"; it was four *groups* — the branding-reminder dismissal, the three notification functions and the three onboarding functions — which is three files and seven functions. They resolved the tenant with `requireTenantContext`, the page primitive, which reads the session's ambient organization, so in a second tab showing another organization they acted on the wrong one. They now take the organization they act on and use `resolveActionContext` (a non-member gets a quiet refusal, a member with the wrong role gets `FORBIDDEN`, like every other action). A structural test fails if any "use server" file calls `requireTenantContext` again, with a positive control; four mutations each fail a test. **Side discovery:** the staff layout's `getMyNotifications()` had been acting as an accidental *second access gate* — it redirected unauthenticated visitors as a side effect, in a layout whose own comment says it must never be one. It now runs only when a staff context exists and each page enforces its own access; verified signed out (`/payments` and `/admin/locations` still redirect to login).
2. **A member without a page's role gets a 404, not a raw 500.** `requireTenantContext(["ADMIN"])` threw a bare `Error("FORBIDDEN")` — an unhandled 500 on every Owner-only page. It now calls `notFound()`, the same refusal `/platform` gives a non-super-admin, so the route does not announce that it exists. Confirmed as a real HTTP 404 for an invited Instructor on `/admin/staff`, `/admin/locations` and `/admin/branding`. Actions still throw `FORBIDDEN`; `error.tsx`'s comment, which described the old behaviour, was corrected.
3. **`/admin/locations`, Owner-only and add-only.** A name (required, up to 100 characters) and an address (optional, up to 200); **no timezone field**, so a new location gets the same default the first has. The slug is the organization's slug plus the slugified name, with a numeric suffix when taken — `Academy.slug` is unique across *all* organizations, so another organization's academy can hold the candidate (the lookup is the existing unscoped `resolveAcademyBySlug`; the unique constraint is the backstop: two organizations claiming the same slug in the same instant would fail one request, with nothing written, rather than corrupt anything). **One transaction** creates the academy with its kiosk token hash, its default plan through `ensureDefaultPlan` (which now accepts the transaction it runs in) and an `academy.create` audit row that never contains the credential; a test makes the plan write fail and shows nothing is left behind. A name already used at the organization — any case or spacing — is refused under a per-organization advisory lock, so two Owners cannot both win; that was my call rather than a stated requirement, and it means an Owner cannot add a location named like the *first* academy, which is named after the registration city (seen in the browser). A new location grants nobody but the Owner access to it. **The token is shown once** through one provider above the page — the shape that fixed the staff invitation link — so the refresh after a creation cannot unmount it, a second location does not hide the first one's (still valid, unrecoverable) token, and a refused add keeps what was typed; the panel is built client-side from the response and the token is never stored. **A test proves the returned token authenticates that academy's kiosk** end to end: a student signs up at the new location through the public form, is approved, and checks in through `POST /api/kiosk/check-in` with it — with controls showing the first location's token and a made-up one are refused, and the new token does not open the first kiosk. The Owner-only structural scan now covers this file too. Eight mutations each fail a test; widening the action's gate is caught by that scan and not by the integration tests, because the service refuses a non-Owner on its own (two layers, deliberately).
4. **"All locations", and no choice offered at exactly one location.** "Ambas sedes" / "Both" is now "Todas las sedes" / "All locations" everywhere (the switcher and the Students, Payments and Analytics filters). At exactly one location the switcher and the Students and Analytics Both filters are hidden (Payments already hid its own); an Owner sees the location's *name* where the switcher was — a judgement call, so they still know where they are. A bug found in passing: the shell's location label said "Both locations" for an Owner with a single location, because nothing had ever selected one. One rule (`hasAcademyChoice`) sits behind every surface, and a structural scan fails if a file offers "all locations" without *calling* it — planning the mutations showed that a leftover import satisfied my first version of the scan, so it was tightened before commit. Seven mutations each fail a test.

Suites: unit 441 → 462, integration 583 → 607; lint at its baseline of 23 warnings, 0 errors.

**Verified in a real browser** as a freshly registered Owner (register → approve as super-admin → invitation link → set password): the onboarding wizard ran end to end through all three converted actions, and the branding reminder's dismissal persisted across a reload; **at one location** the sidebar showed the plain name, with no switcher and no Both filter on Students, Payments or Analytics; a duplicate name was refused with what I had typed kept; **Cartago was added**, its kiosk link appeared, survived the page's own refresh, and after a reload was gone (not in the DOM either), while the switcher and the "All locations" filters appeared; a student signed up at Cartago through the public form (it is selectable there), the Owner approved them, and **they checked in at Cartago's kiosk with the token that had been shown once** — "You're checked in, Carla Cartago!", saved to the class I had created there; an Instructor invited to Cartago through the staff page (which lists it) got a real 404 on the three Owner-only pages and sees only Cartago. Verification data was deleted afterwards and none remains.

**Found while verifying, and not fixed in this PR — the fourteenth instance of "built it, never wired it", and launch-blocking.** That same check-in screen also showed **"1 / NaN"** and **"NaN attendances to go for your next stripe"**. The kiosk client (`kiosk-client.tsx`) types the API's `summary` as `{ remainingToNextStripe, examEligible }`; the API returns an `AtBeltSummary`, whose fields are `remainingAttendance` and `isEligible`. `remainingToNextStripe` is therefore `undefined`, which is not `null`, so the client adds `1 + undefined` and renders "NaN" — on **every real check-in at every organization**, the one screen students stand in front of. It dates from the original kiosk UI commits (`ba8e17d`, `3897d92`); the portal's self-check-in reads the right names and is unaffected. It survived because the kiosk tests mock or assert the API's response and no test renders the success screen from a real response — and because nobody had looked at the screen after a real check-in. It is on the launch checklist below as its own small PR.

**Not built, by decision.** Locations are add-only: no rename, no address edit, no deactivate. The first academy's name comes from the registration city and cannot be changed by the Owner — worth checking Alliance's before it launches. `staff-management.test.ts` still adds its second academy directly (its comment now says why: that file is about staff, and adding one through the product is this revision's test).

---

## What changed in revision 37 — B0: real students can reach the student portal

**The finding.** While researching B4 (the student/staff account conflict) I noticed that only three places in the code ever create an `OrganizationMembership` — `approveOrganization`, `acceptInvitation` and the seed — and that the public student signup creates a `User` and a `Student` and no membership. So I signed a student up through the real form, had them approved, and logged in as them: **"No organization access — Your account isn't linked to any organization right now."** Every real student was locked out of the portal. `/portal` reads the tenant context, and the tenant-context resolver requires a membership; the seed hand-writes its students' memberships, which is the only reason the portal ever appeared to work. Alliance's students outnumber its staff by roughly fifty to one, and not one of them could have used it.

*The thirteenth instance of "built it, never wired it" (the project's own count) — and by user count the worst.* The portal, the signup, the approval and the resolver were each built and each passed their own tests; nothing ever connected a signed-up student to the membership that lets them in. It survived for the same reason the owner lockout did: every test of the portal (`self-check-in-action`, `signup-linking`) builds its student by hand with a hand-written membership, so none of them ever exercised the real path from signup to portal. Found only by signing up as a real student and logging in.

**A lesson one layer down: a test's SETUP has to walk the real path too.** The first draft of the fix's test built its organization with a bare `prisma.organization.create` and failed — not on the assertion, but because signup could not find a belt rank. `approveOrganization` does not seed belt ranks; the public *registration* does, so the hand-built fixture had skipped a real step and was testing a world that does not exist. It is the same failure as the finding itself, one layer down: the portal was never exercised because every test built its student by hand, and the first attempt to exercise it was defeated by a fixture built by hand. Building the organization through `registerOrganization` fixed it. The rule the project already held for *features* ("verify as a registered user, never a seeded account") applies equally to a test's arrange step: if it takes a shortcut the product does not take, it is testing a system nobody runs.

**The fix, test first.** `tests/integration/student-portal-access.test.ts` registers an organization the real way, signs a student up through the real public action, has staff approve them through the real action, and then does exactly what `/portal` does (`requireTenantContext(["STUDENT"])`) as that student — red for the right reasons (no membership), green after. **Staff approving a student creates their `STUDENT` membership**, not the signup: a membership records "this person belongs here", which a pending applicant does not yet, and it avoids dangling rows for applicants who are never approved — mirroring how `approveOrganization` grants the director's. **Archiving a student switches the membership off** (B2's per-organization `active`), so they lose the portal and the account is untouched. Two guards, each pinned by its own test: it **never overwrites an existing membership's role** (a coach who also trains has a staff membership and a linked `Student` record — approving that record must not demote them), and archiving **only ever switches off a `STUDENT` membership**, never a staff one. A student staff entered by hand has no account, so nothing is granted. Both approvals and archives record what they did to the membership in their audit row (`granted` / `existing` / `none`, `revoked` / `kept` / `none`). Four mutations, each caught by the test written for it.

**Verified in a real browser**, with a freshly registered Owner as the staff (register → approve → accept → sign in): a student signed up through the public form; before approval they logged in to "No organization access" (correct — a pending applicant does not belong yet); the Owner approved them on the student's page; they logged in and landed on **their own portal** ("Hi, Sofia!", their blue belt and progress, their academy's schedule, check-in, payment status); the Owner archived them and they lost it again. Verification data was deleted afterwards.

**Found, and scheduled as B5 — before launch, not after (built in revision 39).**
- **Nothing can reverse an archive**, though the confirmation says "This can be reversed by editing status later." `status` is deliberately not editable on the edit form, so that promise has nothing behind it — a claim with nothing proving it. Students taking a break and returning is the normal rhythm of a jiu-jitsu academy, not an edge case, and since B0 archiving also revokes portal access, there is no route back at all. B5 makes it reversible through `grantStudentMembership` (which already switches a deactivated `STUDENT` membership back on); until it lands, the dialog must stop promising something that does not exist.
- A **pending applicant** who logs in sees the generic "your account isn't linked to any organization", which reads as an error. B5 makes it say they are awaiting approval — otherwise they message the academy, and the academy messages the platform admin.
- Students approved *before* this change have no membership and are not backfilled (none exist in production; a development database that has some needs a one-off script).

---

## What changed in revision 35 — staff management, and the two defects it was blocked on

Until now nothing in the product could add an instructor, appoint a location director, assign anyone to an academy or remove anyone: `staffAssignment` was written only by the seed. Revision 33 found it (launch-blocking); this closes it.

**Two defects, each fixed test-first (red, then green).**

1. **`acceptInvitation` overwrote an existing account's password.** It set the password of whichever account owned the invited address, unconditionally — right for a brand-new account, destructive for anyone who already had one. Reachable at bootstrap (the runbook's step 9 mails an invitation to the platform admin's own address, and the runbook carried a "do not open it" warning). `tests/integration/accept-invitation-existing-account.test.ts` was red against the old code for the three real reasons — the original password stopped working, a link minted a session, and an existing account could not accept without inventing a password — and the two brand-new-account cases were green throughout as regression guards. Now there are three cases: **no account** (created, with the password they choose, active, with the invited role); **an unaccepted placeholder** (`active: false`, which `approveOrganization` creates for a new Owner — sets a password, is activated); **an existing, active account** — its password is *never* touched and none is asked for, they gain the membership, and **no session is minted**: holding a link proves control of an email address, not of the account. The accept page is now a server component so the *server* decides whether to show a password field (`describeInvitation`, pinned to the action's rule by its own test).
2. **`User.active` is global, so "deactivate" locked people out of every organization.** `OrganizationMembership.active` is the per-organization switch, checked in `resolveContext` beside the account's, on every request and never cached — a deactivation takes effect on the very next one. Every other place that lists or counts memberships now respects it (sign-in organization resolution, the organization picker and its action, the dev bypass, notification recipients — a deactivated member stops receiving that organization's digest and notifications and keeps receiving the other's — and the platform panel's member list). Assignments are kept while inactive, so a reactivation restores the same scope. `tests/integration/membership-deactivation-is-per-organization.test.ts`: a coach at two academies is deactivated at one and keeps the other, and can still sign in.

**The tool.** `/admin/staff`, **Owner only** (ADMIN): the page demands it, every action demands exactly `["ADMIN"]` (`tests/unit/staff-actions-are-owner-only.test.ts` fails the build if one stops), and the service refuses a non-Owner context a third time. A location director or instructor is refused (`FORBIDDEN`); an Owner of another organization is told `notFound`, never a hint the member exists. Invite by email with a role (Owner / Location director / Instructor) and, for the latter two, at least one academy of *this* organization; edit role and academies; deactivate/reactivate; resend and revoke pending invitations; the invitation link is **always** handed back to copy, because email is sandboxed in dev and can fail in production (`emailSent` says which). A pending invitation grants nothing: the user, membership and assignments are created at acceptance. Resend kills the old link and issues a new one (role and academies carry over); an expired invitation may be resent, a used or revoked one may not. The invitation email goes out in the organization's own language.

**The guards, each with its test.** Nobody deactivates or demotes themselves (`selfChange`). The organization is never left without an active Owner (`lastOwner`); an Owner whose *account* cannot sign in does not count. With self-changes refused this is only reachable by two Owners removing each other at the same moment, which a count-then-write cannot stop — so every staff mutation takes a per-organization Postgres transaction advisory lock (`pg_advisory_xact_lock`, released with the transaction, safe behind a transaction pooler), and a test runs the two removals concurrently and asserts exactly one wins. A director or instructor always keeps at least one academy, and only academies of this organization (`academyRequired`, `invalidAcademy`). A `StaffAssignment`'s role always equals its membership's role and an Owner has none — asserted after every step of a five-step edit sequence, not just one. Every mutation writes its `AuditLog` row in the same transaction (`staff.invite`, `staff.invitationResend`, `staff.invitationRevoke`, `staff.update`, `staff.deactivate`, `staff.reactivate`, and `staff.accept` — which also records every Owner's own acceptance).

**How it was verified.** Every guard is mutation-tested — ten production mutations (the resolver ignoring `membership.active`, `acceptInvitation` always overwriting, the advisory lock removed, both self-change guards removed, the assignment role not synced on update, the last-owner check removed, sign-in counting deactivated memberships, `academyRequired` removed, student accounts not refused, deactivated members still notified) each fail the test written for them, and the lock mutation fails *only* the concurrency test, which is what proves the lock is necessary rather than decorative. In a real browser, as two **freshly registered** Owners (registration form → approval script → invitation → password → sign-in — no seeded account): Owner A invited a brand-new coach (who set a password and landed in the app, not in onboarding, seeing exactly the Instructor's navigation) and Owner B's *existing* account as a Location director (offered only "Join" — no password field — joined without being signed in, then signed in with the **original** password, chose between the two academies, and saw the Director's navigation); Owner A edited the coach's role, deactivated Owner B *in academy A*, and Owner B then signed in, landed in their own academy and was offered only that one; resend and revoke each killed the old link. Verification data was deleted afterwards; the dev database holds only the seeded Alliance organization again.

**What driving the real UI found, that no test had.**
1. **A resent invitation's new link was never shown.** The link lived in the invitation row's own state, and a resend replaces the invitation (new id), so the refresh that follows unmounted the row — while the panel from the *original* invite went on showing a link that had just been killed. When email fails, which is the whole reason the link is shown, an Owner could not obtain a working link at all. One shared "latest link" panel now holds it: a newer link replaces an older one and cannot vanish.
2. **A refused invitation wiped the form** (React resets an uncontrolled form after every action, including one that failed validation), so forgetting to choose a location meant retyping the email. The fields are controlled now.
Both are pinned by component tests (`tests/unit/staff-forms.test.tsx`) and mutation-tested against the original behaviour; the integration tests could not have caught either, because they call the actions directly — the same reason revision 33's bugs, and revision 34's payment-method bug, survived.

*The eleventh and twelfth instances of "built it, never wired it" (the project's own count; the ninth was revision 33's registration form, the tenth revision 34's payment method).* Each was made of parts that were individually correct — an action that returned the new link, a panel that could display one, a form that could show an error — and wired together wrongly: the link was handed to a component the refresh was about to unmount, and the error path went through a form reset that discarded the input. Neither is a large failure like the ninth or tenth, but they were found the same way and by nothing else: this is the **third consecutive feature PR** (B1, the payment plans, and this one) in which driving the real product as a registered user found what the whole test suite had passed over.

**Also observed, not changed.** A staff member who opens a page above their role (an Instructor visiting `/admin/staff`) gets a bare 500, not a friendly redirect: `requireTenantContext` throws `FORBIDDEN` for a wrong-role member. Access is denied and the navigation never offers the link, and the *existing* Owner-only pages (`/admin/schedule`) behave identically — so this is a pre-existing rough edge in the shared guard, not something B2 introduced, and it is left for its own change.

**Known limits, deliberately not built here.**
- ~~**A student account cannot also be staff**~~ — **fixed in revision 40 (B4)**; see that revision's section. *Was, as reclassified in revision 36 as LAUNCH-BLOCKING:* The middleware gates the staff route tree on the global `User.role` in the session, so one account cannot be both a student (`/portal`) and staff (`/dashboard`). The invite is refused with a clear error (`studentAccount`) rather than producing a login that goes nowhere. This was first written up as "will be hit at the first real staff invitation". That understated it: in a jiu-jitsu academy it is hit at **every** staff invitation, because the instructors are the students — the head coach trains there, the purple belt covering Tuesdays trains there, and Alliance's whole coaching staff already exists as student records with student logins. And the second-email workaround makes the problem permanent rather than temporary: the same person checks in for their own training under one account and takes attendance under another, with their belt progress in one and their teaching in the other — the person who uses the app most, permanently split across two identities. The fix is proposed separately (B4, after B3) because it touches authentication.
- **A director is not limited to one location, and a location does not get at most one director.** The roles say "runs one location"; the tool enforces only what was specified — at least one academy. Say if it should be tightened.
- The invitation link is shown once (the database keeps only its hash). A lost link is replaced by resending, which invalidates the old one.

---

## What changed in revision 34 — payment plans, default amounts, organization currency

Before this revision a director could record a payment only against plans the seed had created; nothing created, priced, edited or retired a plan, a newly approved academy had **no plan at all** (so its owner could not record a single payment), and every amount was a bare number displayed as colones.

**Plans** (`/payments/plans`, ADMIN and DIRECTOR; a location director manages the plans of the academies they run, the owner all of them). Create, edit, deactivate, reactivate — **never delete**: every payment ever recorded references its plan. There is no delete action, `tests/unit/payment-plans-are-never-deleted.test.ts` fails the build if application code grows one, and the database refuses it independently (a plan with history cannot be deleted; asserted in the integration test). A deactivated plan leaves every picker and `recordPayment` refuses a *new* payment on it (`planInactive` — this was a real gap: the picker hid it but a stale form or a hand-built request could still write to it), while every past record keeps showing its plan, amount and currency. Correcting a payment that already sits on a deactivated plan still works, because the plan is not changing. An academy's **last** active ordinary plan cannot be deactivated (`lastActivePlan`) — the system promo plan does not count as a substitute. The system promo plan (`Promoción personalizada`) is locked: it cannot be edited, renamed or deactivated, and a director cannot create a plan with its name. All four operations write an audit row in the same transaction.

**Default amounts.** `PaymentPlan.defaultAmount` is a suggestion only. Picking a plan pre-fills the amount *only while the director has not decided it*; typing marks it decided, and editing a payment that already has an amount starts decided, so a correction is never silently overwritten by the plan's current price.

**Currency — one per organization, snapshotted per payment.** `Organization.currency` (`CRC` | `USD`, default `CRC`), chosen on the registration form and by the platform's new-organization form, changeable **by the owner only**, audited. Every `PaymentPeriod` carries its own `currency`, copied from the organization *at the moment the payment is recorded* and never rewritten — the same reason `graceDaysApplied` is a snapshot. It has **no database default**, so a new code path that forgets to set it fails to compile rather than quietly recording colones. Correcting an existing payment keeps its currency; a carried-forward recurring promo copies its *source row's* currency, not the organization's current one. The rule that matters is written on the column itself (`prisma/schema.prisma`): **never sum, average or compare `amount` across rows without grouping by `currency`**, and `tests/unit/payment-amounts-are-currency-aware.test.ts` fails any production file that aggregates payment amounts without mentioning currency. No such aggregate exists today; the guard is there for the first revenue total someone builds. Changing the currency converts nothing — old payments stay in their currency and plans' default amounts are bare numbers (the form says so).

**A new academy can take a payment on day one.** `approveOrganization` creates one active monthly plan for the default academy, named from `Organization.defaultLocale` (`Mensualidad` / `Monthly`), no default amount (the app cannot know the price). It runs only when the academy is created: re-approving or resending an invitation never resurrects a plan the director deactivated, nor duplicates it. `markPaymentPaid`'s "the ordinary monthly plan" fallback recognises both names.

**How it was verified.** Integration test `payment-plans.test.ts` builds every scratch organization the real way (registration action → approval → invitation → password), and mutation-testing confirmed the `planInactive` gate and the carry-forward currency copy are each pinned by a failing test. In a real browser, as two freshly registered owners (registration form → approval script → invitation link → password → sign-in): an English/USD academy got `Monthly`, showed `$` everywhere, created a priced plan, pre-filled the amount, recorded payments, deactivated a plan with history (gone from the picker, still in the Pagos table and the student's history), was refused deactivating its last plan, switched to colones (a new payment `₡ 22,500`; the September payment corrected afterwards stayed `$ 50.00`); a Spanish/colones academy got `Mensualidad` and `₡`. Dev verification data was deleted afterwards; the dev database holds only the seeded Alliance organization again.

**What verification found — three things, one of them not this revision's:**

1. **A payment saved with the method left on "Unspecified" always failed** ("Please check the form for errors"). Pre-existing, on `main` before this revision: the form's strip list removed blank `amount`/`notes`/promo fields but not `method`, whose default option submits `""`, which `z.nativeEnum(...).optional()` rejects. Invisible for the same reason as revision 33's bugs — the seed writes payments directly and the unit test mocked the action. Fixed (`method` joins the strip list) with two new form tests; the failing one was written first.

   *The tenth instance of "built it, never wired it" (the project's own count; the ninth was the registration form in revision 33) — and the most costly kind: **the core daily workflow, broken on `main`.*** A director could not record a payment without first choosing a method, and "Unspecified" is the default the form opens on. The server's contract (`method` is optional) and the form's contract (send `""` for "none") disagreed, and the only test of the form mocked the action, so the two halves were never run against each other — the same shape as the ninth instance, where every test built its `FormData` by hand. What found it was not review or a test but a person doing the job: a registered owner filling in the real form. That is now the third bug in a row surfaced only by driving the real path (owner lockout, registration, this), which is the argument for keeping the "verify as a registered user in a real browser" rule non-negotiable.
2. **The tenant guard blocks `paymentPlan.update` without `organizationId`** — every plan edit, deactivate and reactivate would have thrown in production. Caught by the integration test, not by the browser; fixed at both call sites. **This is the first time the guard has paid off during development rather than in an audit**: the guard built after the three tenant-isolation leaks (revision 24) blocked a *fourth* unscoped write before it could ship, with an error that named the model, the operation and the fix. Every plan edit, deactivate and reactivate would have thrown in production.
3. **Approval now creates a plan, so every test that approves an organization and then deletes its academy hit a foreign key.** Three test cleanups gained a `paymentPlan.deleteMany`. A reminder that "approval creates rows" is now true of plans as well as academy, branding and ranks.

**The system promo plan follows the organization's language.** It was `Promoción personalizada` in every organization, so an English academy saw a Spanish system plan. Its name now comes from `Organization.defaultLocale` (`Promoción personalizada` / `Custom promotion`), the same rule as the default monthly plan. Because a row is created once in one language, no code may compare against a single name: every check goes through `isCustomPromoPlanName()`, which accepts either, the old exported constant is gone (a missed call site fails to compile), and `ensureCustomPromoPlan` looks a plan up under *every* language's name before creating one — so an organization that already has the Spanish-named row keeps it rather than gaining a second. `tests/unit/custom-promo-plan-name.test.ts` fails the build if any other production file hard-codes either name; it caught one in a comment on its first run. Three integration tests pin the behaviour (each mutation-tested: always-Spanish and look-up-only-the-localized-name both fail one), including that the English-named plan is still locked, still requires a promo name, still ignored by the last-plan guard and still carries forward.

**"A payment on a deactivated plan can still be corrected" — now proven, and its real reach measured.** This was a stated design claim with nothing behind it. `tests/unit/payments-table-edit-sheet.test.tsx` now pins the UI half (the Pagos edit sheet offers the payment's own inactive plan, marked, selected, and submits it unchanged; mutation-tested), and the integration test pins the server half. In a real browser, as a freshly registered owner: a Promotional payment recorded on a plan, the plan deactivated, the payment's Edit sheet opened — `Scholarship (inactive)` selected, amount and status intact — and a correction saved with the payment still on the deactivated plan. **What that measurement also showed is how narrow the reach is:** Pagos offers **Edit only on promotional/exempt rows**; a *paid* row offers only "View receipt". So a paid payment on a deactivated plan cannot be corrected *in place* from Pagos, and the student-page form (active plans only, and it cannot know which month the director will choose) can only move it to an active plan, which is what the earlier browser run did. Nothing is frozen — the payment can always be moved — but "keep the plan and fix the note" works only for promotional rows. Whether paid rows should get an Edit in Pagos is a product decision, not a plans bug, and is left open.

**Known limits, deliberately not fixed here.** The sheet's narrow plan select clips the "(inactive)" suffix. Currency is **not** the same gap as timezone: an organization outside `America/Costa_Rica` is still wrong from day one on attendance dates and check-in windows (launch checklist).

---

## What changed in revision 33 — the owner lockout, a registration form that rejected every real submission, and the rule that found both

Both bugs below were invisible for five phases for one reason and were found by one act: driving the product as a user created **the way a real customer's is** — `/register-academy`, approval, invitation, password, sign-in — instead of as a seeded account. Alliance is seeded, and the seed is the only thing that ever wrote the rows these bugs concern. **Standing rule from this revision: a UI verification that works by logging in as a seed user does not count.**

**1. Every customer organization's owner could see nothing.** `approveOrganization()` made the registering owner a `DIRECTOR`. A `DIRECTOR`'s scope is the academies in their `staffAssignment` rows (`resolveAcademyIds`), and nothing outside the seed script creates one; an `ADMIN` resolves to every academy. So a real customer's owner had zero academies in scope (every query filtered by `{ academyId: { in: [] } }`) and was locked out of the owner-only gates — class schedule, kiosk-token regeneration, logo upload, including onboarding's own logo step. In the dev database: an organization with one academy whose owner held zero assignments.

*What the evidence did and did not show.* A Phase 5 screenshot of a newly registered organization's dashboard (`.review-shots/6-new-org-dashboard-shows-alliance-bug.png`, taken to capture a different bug — the hardcoded "Alliance Costa Rica" header) already carried the role evidence: no Schedule item in the sidebar and no academy switcher, both `ADMIN`-only. It was on screen and unread; nobody asked what role that user held. Zero academies was **not** visible either way — no academy list appears on that screen, and all-zero KPIs are what any empty new organization shows. The scope claim rests on the code path and the database row, not on the image.

*Fix, test first.* A test registers an owner exactly as the product does (the real `approveOrganization()` and `acceptInvitation()`) and asserts the outcome, not the mechanism: the organization's academy is in their scope, the `ADMIN`-only gates let them through, and no scope narrowing applies. Red against the old code (`scope was []`, `FORBIDDEN`, `{ academyId: { in: [] } }`), green after approval grants `ADMIN`. Checked what the change touches: one function writes this role for every path (the approve button, the new-organization form, resend, the CLI); `Invitation.role` is never read; `User.role` is read only by credentials and the token, and the middleware's staff check already includes `ADMIN`; the owner now also receives every organization notification and digest, which is the intent.

**Roles, decided — and a proposed merge cancelled.** `ADMIN` is the organization's **Owner** across every location. `DIRECTOR` runs **one** location. `INSTRUCTOR` is scoped to assigned academies. `isSuperAdmin` is platform-level and orthogonal. An `ADMIN`/`DIRECTOR` merge (73 code sites in 39 files, plus 343 test lines and three enum columns) was proposed on the belief they were interchangeable; enumerating every check showed they differ in scope, in the owner-only gates and in notification routing, and that one director per location is wanted. The original confusion was labelling. The enums are untouched; the UI now says "Dueño"/"Owner" and "Director de sede"/"Location director" (the platform panel previously printed the raw enum).

**2. The public registration form rejected every genuine browser submission — since #24 (2026-09-18).** A valid submission returned `{"error":"invalid","fieldErrors":{}}` and wrote nothing, so no customer could register. `useActionState` binds the action to its previous state, so Next's runtime submits its own hidden fields (`$ACTION_REF_1`, `$ACTION_1:0`, `$ACTION_1:1`, `$ACTION_KEY`) with the visitor's. #24 made the schema `z.strictObject` — correctly, so a crafted `logo` or `primaryColor` is rejected, not silently dropped — which then read the framework's plumbing as unknown fields and failed everything with **no field errors**. Every test built its `FormData` by hand and never carried them. Billing had hit the same class of bug (revision 26) and worked around it in that one file. The super-admin create-organization form had the identical defect. Fixed by `formDataToObject()`, which drops only the reserved `$ACTION_` namespace before strict parsing, so strictness is kept; a test carrying the real captured fields (red output byte-identical to the browser's response), a test that a genuine unknown field alongside them is still rejected, and a **structural guard** that fails if any file calling `z.strictObject()` parses form data raw — mutation-tested. A further test pins the namespace as a one-way drain: a `$ACTION_`-prefixed field is dropped and never processed (it cannot shadow a real field or trip the honeypot), and the prefix match is exact, so a lookalike is kept and rejected by the schema.

*The ninth instance of "built it, never wired it" (the project's own count) — and the first one CAUSED by a hardening change.* #24 was made for exactly the reasons the earlier eight taught: the acceptance criterion "the public form accepts no file upload and no color input" had been ticked on Zod's default of stripping unknown keys, not on a real rejection, so `z.strictObject` was requested to make it true. It did — and in closing a theoretical hole it opened a total one: public registration was broken from the day it merged. It stayed green because every test built its `FormData` by hand, so nothing drove a real form. The earlier instances were features never connected; this one was rigour applied at the wrong layer, which is still a hole. The lesson is not "don't harden". It is that **the verification has to move with the change**: a hardening of how input is parsed must be verified against real browser input, not against input the test author constructed. The structural guard is the better half of the fix — it makes the class impossible instead of patching the instance, and confirming that it fails on revert is what makes it evidence rather than decoration.

**Also fixed:** a platform admin with no organization landed on a dead-end page whose only button was "sign out" — they now go to `/platform`; and one who also owns an organization (the runbook's bootstrap makes the first platform admin their own organization's owner) gets a "Platform" entry in the user menu.

**Found, not built — each is its own PR:**
- **No UI adds staff, assigns academies, or creates a second location.** `staffAssignment` is written only by the seed; `academy.create` runs only in `approveOrganization` (one default academy) and the seed. Alliance has *two* locations and registration creates exactly one. **Launch-blocking** — see the checklist.
- **`acceptInvitation` overwrites an existing account's password unconditionally.** A bug, not a design point: someone who already has an account, invited into a second organization, silently loses their password.
- **`User.active` is global**, so deactivating a staff member in one organization would lock them out of every organization they belong to; `OrganizationMembership.active` is the fix.
- **A single-location organization sees "Ambas sedes / Ver ambas sedes"** in the academy switcher — copy that assumes Alliance's two locations.

**Verified in a real browser as genuinely registered owners:** registration → "Solicitud recibida"; approval; the invitation link; password; the onboarding wizard including a real logo upload; the dashboard with the academy switcher, the Schedule item and the "Administración" card; the kiosk-token page and a regenerated token; the Schedule page; "Dueño"/"Owner" in the user menu and the platform panel in both locales. The platform admin, registered as an owner through the same flow, signed in with their *original* password (the reuse branch leaves it untouched) and gained the Platform entry, which a plain owner does not have.

---

## What changed in revision 32 — SSL decided and built on the mechanism that actually applies, and a first-deploy verification step that is a script

Revision 31 left SSL as an open decision and Supavisor as "watch for it". Before picking a value, this revision checked how TLS is actually configured on this project's path — the same engine-versus-adapter trap that made `pgbouncer=true` inert — against a real Postgres with TLS and a private CA, asking the server itself whether each session was encrypted. Four findings, none of them obvious, all pinned by tests:

- **`pg` defaults to plaintext** even against a server offering TLS, and Supabase accepts plaintext by default. The authoritative control is the Pool's `ssl` option, not the URL's `sslmode`.
- **URL parameters override the Pool's `ssl` option** (`Object.assign({}, config, parse(connectionString))`): `?sslmode=verify-full` next to `ssl: { ca }` silently discards the CA. Verified as a failure, not read from source alone.
- **With an IP-address host `pg` validates the certificate against `"localhost"`**, not the IP — so "verified" would be a false claim. With a DNS host the name is checked (a certificate signed by the right CA that doesn't name the host is refused).
- **The Prisma CLI is a different path, and it is the reverse trap**: `sslmode=require` and even `sslmode=verify-full` connected against a *wrong* CA. Only `sslaccept=strict` + `sslcert=<CA file>` verifies (chain and hostname).

**Built.** `DATABASE_SSL_CA_B64` (the provider's CA, base64 — public, so no handling risk, and rotation is a config change) → full verification through the Pool's `ssl` option (`src/lib/prisma/database-ssl.ts`). The resolver refuses the configurations above: URL TLS parameters next to the CA, an IP host, and — closing the silent-plaintext default — a remote database in production with no TLS configuration at all. Verified that `next build` itself constructs the client, so a Vercel build without the variable fails; the runbook says to set it for Build too. `DATABASE_SSL_MODE=no-verify` is the explicit fallback: it warns on every start, `pnpm verify:pooling` ends `PASS, ON THE TEMPORARY no-verify FALLBACK` every time it runs, and the runbook's "SSL fallback" names an owner (Alexis) and an exit condition — so it cannot quietly become permanent. A remote `DIRECT_URL` must state `sslaccept` explicitly, because the silent default there is "encrypted, unauthenticated". The pool and client are now built by shared factories (`src/lib/prisma/database-pool.ts`) so the verification script tests the app's real configuration, not a copy.

**The verification step** is `scripts/verify-pooling.ts` (runbook step 11): TLS session verified; 360 concurrent queries and transactions through the app's real client, each checked to return *its own* answer; a control that opts in to named prepared statements; and, optionally, 90 concurrent requests to the deployed app — the real serverless shape. Rehearsed against a real PgBouncer 1.25.2 with TLS in front of the migrated test database: pass; wrong CA; missing TLS config; fallback; a failing control; a failing app URL. **That rehearsal corrected revision 31's framing:** at its defaults that PgBouncer *tolerated* named prepared statements (0/120 failed) and only failed with `max_prepared_statements=0` — pooler support varies by pooler and version, which is why the app doesn't depend on it, and why the script reports the control as information rather than a pass/fail.

**Still not verified, and where it will be:** Supavisor, and that Supabase's pooler certificate names the pooler's hostname. Step 11 is the first time either is tested; its failure list says what to do, including the `openssl s_client -starttls postgres` command that shows what the certificate actually names.

---

## What changed in revision 31 — the pooling fix implemented, and the runbook's own account of it corrected

Revision 30 (below) found a real gap — `unscoped.ts` had no pooler awareness — and *documented* a fix in the runbook without implementing it: the schema had no `directUrl`, there was no second env var, and anyone following the runbook would have been half configured. This revision builds it, and verifying it against the path this project actually uses (the `PrismaPg` **driver adapter** over node-postgres, not Prisma's own engine) overturned most of the runbook's technical claims. Checked against adapter source, `pg`'s own connection-string parsing, and a real PgBouncer 1.25.2 in transaction mode — not documentation alone. **Supavisor itself has not been exercised; the first production deploy is its first test.**

**What revision 30 got wrong, owned plainly:**
- **`?pgbouncer=true` — wrong path.** It is a Prisma *engine* parameter. On the adapter path `pg` parses it into an inert key and its startup message sends only a fixed whitelist of parameters. No effect; removed from the runbook.
- **The actual hazard was misnamed.** Transaction pooling breaks *named* prepared statements. `@prisma/adapter-pg` creates named statements only when given a `statementNameGenerator`, which this app never supplies — 0 rows in `pg_prepared_statements` from the app's real client. A control that *does* opt in fails 110 of 120 concurrent queries with `42P05`. Both halves are pinned in `tests/integration/no-named-prepared-statements.test.ts`, so the safe state is enforced, not assumed.
- **`max: 1` — bad advice.** Vercel's own guidance for `pg` on Fluid compute is to avoid it; the pool keeps `pg`'s default max, with `idleTimeoutMillis: 5000` and `@vercel/functions`' `attachDatabasePool` (now implemented in `unscoped.ts`, inert off Vercel).
- **"Migrations need DDL pooling doesn't support" — wrong reason.** `migrate deploy` through a transaction-mode pooler *succeeds* on a fresh database. The failure comes later: it leaves Prisma Migrate's session-level advisory lock held by an idle pooled backend, and the next direct migration times out with `P1002`. A failure one deploy removed from its cause is the worse kind — hence a permanent test rather than a one-off check.

**What was built.** `prisma7.config.ts` now takes the CLI's URL from `scripts/lib/prisma-cli-url.ts`: `DIRECT_URL` when set, `DATABASE_URL` otherwise (local dev and CI unchanged). Prisma 7 removed `url`/`directUrl` from the schema's `datasource` block, so the mechanism lives in the config file, not `schema.prisma`. A hazard this created and closed in the same PR: several scripts and fixtures redirect *only* `DATABASE_URL` to the test database before shelling out to Prisma, so a stale ambient `DIRECT_URL` (say, a production string left in the shell) would silently win and aim a migration at the wrong database. Two layers: `testDatabaseChildEnv()` drops `DIRECT_URL` at every such call site, and the resolver refuses outright when the two variables name different databases. `README.md`'s env table, `.env.example` and the runbook all gained `DIRECT_URL` together. Proven by mutation (each protection removed → its test fails) and by `tests/integration/prisma-cli-direct-url.test.ts`, which runs `migrate deploy` with an *unreachable* `DATABASE_URL` and a good `DIRECT_URL` — success can only mean the CLI went direct.

**Open, needs Alexis before the first deploy: SSL to the pooler.** *(Resolved in revision 32 above: decided, built, and tested; the "commonly fails against Supabase's own CA" line below is the unverified claim it replaced.)* With no `sslmode`, `pg` connects without TLS and Supabase accepts that by default. Strict verification against Supabase's own CA commonly fails with `self-signed certificate in certificate chain`. The options and their trade-offs are in the runbook; nothing was decided or verified against a real Supabase project.

---

## What changed in revision 30 — the deployment gap closed: a stack decided, a runbook written, a real serverless gap found before it shipped

> **Correction (revision 31):** the pooling paragraph below describes a fix that was documented, not built, and parts of it were wrong (`?pgbouncer=true`, the reason migrations go direct). See "What changed in revision 31" above for what is actually true. The paragraph is left as written so the history stays honest.

Phase 0 deliberately left the production database provider undecided ("do not write provider-specific code"). With all eight phases now built, that deferral became the largest remaining unscoped item — everything to this point had run against a dev database on one machine, with no production environment named anywhere.

**Decided: Vercel Pro + Supabase Pro, $45/month, two providers.** Priced against a cheaper option first, not skipped: Railway, consolidating app hosting and the database onto one provider, comes to roughly $20-25/month — a real $240-300/year gap. Chosen anyway, deliberately against the cheaper option, because `vercel.json` already exists in this repo (Vercel's own cron format, not portable as-is) and Next.js on Vercel is the best-documented failure surface for exactly this stack (Server Components, Server Actions) — for a solo operator, an evening lost to an undocumented platform quirk while a paying customer watches check-in fail costs more than the yearly gap. Recorded as an explicit, overridden priority ("cheap ahead of boring," stated, then knowingly not followed) rather than silently reinterpreted.

**A real, unaddressed gap found in the code before any customer ever hit it**: `src/lib/prisma/unscoped.ts` constructs its `PrismaPg` adapter from `DATABASE_URL` as-is, with no pooler awareness anywhere — correct and sufficient for dev's single long-lived Node process, and a textbook serverless-Postgres connection-exhaustion risk the moment real concurrent traffic (several staff loading Panel at once, a burst of kiosk taps at class start) makes Vercel spin up multiple function instances, each opening its own connection pool directly against Postgres. The fix (verified against Prisma's own current docs, not assumed): production's `DATABASE_URL` must point at Supabase's pooled connection (Supavisor, transaction mode) with `?pgbouncer=true` appended — transaction-mode pooling doesn't preserve prepared statements across transaction boundaries, and Prisma's engine uses them by default — while `prisma migrate deploy` needs the *direct* connection instead, since migrations need session-level DDL pooling doesn't support well. Full detail, plus five more failure modes that only exist in production (the digest cron silently never firing on the wrong Vercel environment scope, a freshly created Supabase Storage bucket defaulting to private, email deliverability, kiosk cold starts, and a stale `APP_URL`), lives in the new `docs/DEPLOYMENT_RUNBOOK.md`.

**A circularity in the README's own bootstrap section, caught only by tracing the real code rather than trusting an earlier draft of this same doc's own prose**: "register through the public flow, then get approved" has no path to the *very first* approver in a genuinely empty database — `approveOrganization()` creates a director's `User` row only at approval time, not at registration, and approval itself needs an existing super-admin. Corrected in `docs/DEPLOYMENT_RUNBOOK.md`'s own step-by-step sequence (insert the first `User` row directly via one-time SQL, using the same email as the org's registration contact, so `approveOrganization()`'s own existing-user "reuse" branch — built for the ordinary multi-organization case — attaches the director membership to it instead of creating a second account) and README's own section now points there instead of repeating a sequence that could drift out of sync with it.

---

## What changed in revision 29 — Phase 8 shipped, and a live bug found in already-shipped charts along the way

Phase 8 (dashboard analytics: attendance by class — the last phase in this doc) shipped as its own PR. Full detail lives in Phase 8's own Implementation record, below; the headline finding is worth repeating here.

Before writing a line of new UI, the color question this phase itself named as "the trap" — a director's configurable brand color making chart data invisible — turned out to already be live in two shipped surfaces: `WeeklyAttendanceChart`'s line/area and `BarList`'s own default fill both colored themselves with `var(--brand-gold)`/`bg-brand-gold`, which `branding-scope.tsx` overrides per organization. `class-popularity-panel.tsx` never overrode that default, so its bars were already exposed to exactly this risk. Fixed at the root — `BarList`'s default became a new, fixed, non-brand-configurable `--data` token instead of `--brand-gold` — which corrected `class-popularity-panel.tsx` with no change to that file at all, while the two callers that legitimately use color as data (belt distribution, belt progression) were left untouched. Verified live: a real branding save to a deliberately pale color made the sidebar's own chrome nearly unreadable while every chart stayed the same legible blue, screenshotted in both themes before the branding was reverted.

The new chart itself shares its counting logic with the existing `getClassPopularity` through two extracted helpers rather than a second query, is deliberately not built with recharts (this codebase's only categorical-ranking convention is already a plain div bar, not an SVG axis — which also sidesteps recharts' own long-label-at-narrow-width problem), and is reachable by INSTRUCTOR (unlike the weekly trend beside it) scoped to their own assigned academies through the same `branchScopeWhere` mechanism already used everywhere else on that page.

A real, live gap surfaced while writing `docs/MULTI_ACADEMY_OPERATIONS.md` was folded into this same PR: resending an invitation for an already-active organization had no panel button anywhere, only the CLI script.

---

## What changed in revision 28 — Phase 7 re-scoped against evidence, operations documented, a launch checklist added

Phase 7 was originally written as a six-bullet verification sweep. Checked against the actual codebase rather than built to the checklist as written: most of it had already been happening continuously since Phase 1 (tenant isolation, promotion engine, belt display, theme/contrast, logo validation, registration, admin authorization all already have dedicated test coverage; tenancy and Alliance parity verification already run on every CI build via `check:guard-usage`/`db:check-drift`/`ci:parity-check`; rank labels have come from `BeltRank.labelEs`/`labelEn` since Phase 2/3). One bullet was dead: impersonation-expiry test coverage, for a feature Phase 6 explicitly never built. What was left, real and confirmed by evidence rather than assumed:

- **An i18n key-parity test** (`tests/unit/messages-key-parity.test.ts`) — didn't exist. Walks both message trees to their leaves and diffs the dotted-path key sets in both directions, plus asserts no leaf is an empty string.
- **A hardcoded-literal sweep, done once as a grep rather than built as a lint rule.** A `>text<` JSX-text-node grep across `src/app` and `src/components` returned 23 hits. Every one checked individually: two are the standard "language name in its own language" exception on locale pickers (`English`/`Español` side by side); ~19 are inside `/dev/belts` and `/dev/components`, dev-only visual-QA pages with no auth gate and no nav link, never reached by a real director; the remaining four are `sr-only` (screen-reader-only, invisible to sighted users) accessibility labels inside unmodified shadcn/ui library boilerplate (`sidebar.tsx`, `sheet.tsx`). Zero real hardcoded-literal bugs found. Per the instruction that scoped this ("if it's a handful, fix them and move on; if it's dozens, reconsider a rule"): a handful of raw hits, zero real ones — no rule built, nothing to fix.
- **An invitation-expiry test.** `accept-invitation/actions.ts` has checked `invitation.expiresAt < new Date()` since Phase 5; nothing had ever proven that check actually rejects an expired token rather than, say, throwing or silently succeeding. Added to `organization-approval.test.ts`, matching its existing "already-used token cannot be replayed" test's shape.
- **`docs/REDESIGN_BRIEF.md` audited, not assumed stale.** Every one of its 10 phases describes work that is fully built (confirmed by the existence of every named component, route, and behavior — not inferred). But it is not "scaffolding nobody will read again": ~50 files across `src/` cite a specific phase of it by name as the reasoning behind a real decision (a role gate, a matching rule, a token choice). Deleting it would orphan those citations for no gain, since there is no still-open work in it to fold forward into this doc. Kept as-is, with one added status note marking it as implemented history rather than a task list.
- **`docs/MULTI_ACADEMY_OPERATIONS.md` written**, scoped to what Alexis actually does rather than a restatement of this doc's architecture: approving an academy, bootstrapping a platform admin, suspending/reactivating a non-paying organization, issuing or resending an invitation, running the approval CLI when the panel is down, and checking whether the weekly digest fired. Writing it surfaced a real gap it now documents: resending an invitation for an already-active organization has no button anywhere in the panel — only the CLI (`scripts/approve-organization.ts`, re-run by slug) does it, since the panel's pending-queue page (where "Approve" lives) only lists `PENDING` organizations.
- **README's environment-variable section rewritten and a platform-admin bootstrap procedure added — neither existed before.** The previous README listed no env vars at all despite `.env.example` already documenting nine of them in detail. The bootstrap procedure was a genuine first: there was no documented answer anywhere in the repo for "how does the very first platform admin get created in a real deployment," since the seed script that creates one is refused outside a local/test database by design (`scripts/lib/seed-safety-guard.ts`) and no script exists for granting `isSuperAdmin` directly. Documented as a one-time manual SQL step against the production database, deliberately not a script — the same reasoning the seed guard already applies: a script that grants platform-wide access by running it is a backdoor waiting to be found.

**The launch checklist below is new** — a single list of everything this project has deliberately deferred, named across nine revision entries and a handful of doc comments, each judged against whether it blocks Alliance's own launch or only a future customer's.

---

## What changed in revision 27 — reframed: not a DST gap, a single-timezone platform presenting itself as multi-tenant

Revision 26 flagged the timezone finding as "DST, untested." That framing undersold it. The actual failure needs no DST transition at all: an academy in Santiago checks a student in at 8pm local, and the attendance record lands on the wrong calendar day — silently, in the exact data the promotion engine counts toward a belt. `Organization.timezone` already exists as a column, is already read correctly by three places (`billing/deadline.ts`, `billing/banner.ts`, `promotion/automation.ts`), and is not read by 21 others, all of which convert through a hardcoded `ZONE = "America/Costa_Rica"` constant in `src/lib/scheduling/zone.ts` regardless of which organization is asking. Phase 5 made organizations outside Costa Rica possible; this makes them silently wrong the moment one signs up. It is this project's own recurring shape again: a mechanism gets built (the column, the schema, the migration), and a caller that should read it is left on the old path instead.

Full detail — the per-surface breakdown of what goes wrong (attendance dates, the check-in window, the weekly digest, and the one surface that's already correct), and the sizing (core functions, context-type plumbing, the 21 call sites, the 19 affected test files, and the one real DST-edge-case design decision that keeps this from being pure mechanical plumbing) — lives in the Phase 6 Implementation record, below, where the original finding was recorded. Not scheduled or fixed here: Costa Rica is the current market and every existing organization is UTC-6. Recorded as a sized, known-cost decision to make deliberately, before an organization outside `America/Costa_Rica` signs up, rather than a discovery made by one.

---

## What changed in revision 26 — billing shipped; a test-environment blind spot closed structurally

Phase 6 billing (manual invoices, per-org grace days, pure date-derived `DUE`/`GRACE_EXPIRED` state) shipped as PR #28, exactly as specified in this doc's Phase 6 billing section — no staleness found before building. Full detail, including the two bugs the mandatory live-browser verification step caught that 14 passing automated tests didn't, lives in that phase's own Implementation record, below.

The second of those two bugs — an off-by-one invoice deadline from a UTC-midnight write read back through the organization's own timezone — turned out to have a sibling already living in the test suite: a state-transition test that passed locally only because the development machine's system timezone (`America/Guatemala`, UTC-6) happened to match the test organization's (`America/Costa_Rica`, also UTC-6), and failed the moment it ran on GitHub Actions (UTC). Fixing that one test wasn't enough — the same coincidence could be hiding in any other test that reads the system clock. All three `vitest.*.config.ts` files now force `process.env.TZ = "Pacific/Kiritimati"` (UTC+14 — chosen over plain UTC specifically because UTC is only 6 hours from Costa Rica's own offset and shares a calendar date with it too often to reliably catch this class of bug) at the top of the config file, before `defineConfig` runs — the one placement that actually takes effect under Vitest's default `pool: 'threads'`, per Vitest's own documentation. Run under that hostile zone, the full suite (357 unit + 498 integration) passed clean beyond the one fix. Read narrowly, not broadly (see revision 27): it confirms the three places that already read `Organization.timezone` explicitly are genuinely zone-safe, and that the hostile-zone mechanism itself works — it does not mean the rest of scheduling is multi-timezone-safe, since that code doesn't read the ambient system zone at all and so was never exposed to this test. The generalization from the mechanism itself, still worth keeping: **a test whose result depends on the zone of the machine running it is agreeing with its environment, not testing the code — the only way to find one is to change the environment out from under it.**

---

## What changed in revision 25 — a dependency's console output is a prompt-injection surface, silenced regardless of intent

A `Bash`/`node` command's output twice included a line resembling `◇ injected env (13) from .env // tip: ⌁ auth for agents [www.vestauth.com]` — an unfamiliar third-party domain, printed by a tool call, read directly into an agent's context. Flagged rather than acted on: no URL from the line was fetched, nothing about it was treated as an instruction, and it was surfaced to Alexis explicitly instead of silently continuing.

**Verified, not assumed, per this doc's own standing rule.** `dotenv@17.4.2` (the exact version this repo has installed, confirmed via `node_modules`) ships a hardcoded `TIPS` array in its own `lib/main.js` containing the literal string `'⌁ auth for agents [www.vestauth.com]'` and seven others, one of which is selected at random and appended to the "injected env" line every time `dotenv/config`'s side-effect import runs — a real, documented (if widely disliked — this is an open complaint against the package upstream) promotional-tips feature, not anything injected into this machine. Both occurrences traced cleanly to this source.

**Silenced regardless of what the investigation found**, per the instruction that prompted it: `DOTENV_CONFIG_QUIET="true"` added to `.env`/`.env.example`. Confirmed to work by tracing dotenv's own source, not merely by the absence of the tip line afterward: `configDotenv()` re-checks `DOTENV_CONFIG_QUIET` against `process.env` a second time, *after* merging the parsed `.env` file's own values in — the comment in dotenv's own source calls this "handle user settings `DOTENV_CONFIG_` options inside .env file(s)" — so setting it inside `.env` itself takes effect on that same load, with no code changes needed at any of the ~60 `import "dotenv/config"` call sites across this repo's scripts and tests.

**Why this was worth a revision entry and not just a quiet fix.** The reasoning generalizes past this one package: a dependency that prints arbitrary, rotating, third-party-controlled strings into a console an agent reads is a prompt-injection surface by construction, whether or not any given payload is malicious. Today's content is an advertisement; the mechanism that put it there — an upstream package choosing what text appears in output the next reader (human or agent) will see — is indistinguishable, from the reading side, from a mechanism that could print something else. Turning the feature off doesn't just remove today's noise; it removes the surface itself from every future log this project or an agent working in it will read.

**A structural note, not a finding about this fix specifically.** The pre-commit hook that blocks a direct commit to `main` (`pre-push-main-blocker.sh`, added two days before this revision) caught exactly the mistake it exists to catch on its first real trigger: Phase 6's work began without creating a feature branch first, and the hook refused the commit rather than letting it land. No harm resulted — the branch was created and the same commit succeeded there — but the catch itself is the point: this is what a structural guard is for, checking correctly even when the person or agent operating the tool forgot to. The same argument this doc has made for tenant-isolation guards (a guard is not tested until something takes the unguarded path and fails) applies here too, just outside the tenant-isolation domain.

---

## What changed in revision 24 — the real backstop, and what it found

Revision 23 documented that the "runtime backstop" was never real. This revision builds it: a Prisma client extension (`src/lib/tenant/tenant-guard.ts`) attached directly to the base client at construction (`src/lib/prisma.ts`), so any query against a `TENANT_SCOPED_MODELS` entry with no `organizationId` anywhere in its arguments throws `UnscopedTenantQueryError` — loudly, synchronously, before the query ever reaches the database. Verified directly (not assumed) to fire identically for a query issued inside an interactive `$transaction` callback, both reads and writes — `tests/integration/tenant-guard-transaction.test.ts` — since several of the fixes below keep a write on the raw client specifically because it shares a transaction with an `AuditLog` row, which `getScopedDb`'s wrapper excludes; if the guard had not propagated into `tx`, every one of those writes (payment recording, promotion awards among them) would have been silently unprotected regardless of how green the test suite looked. The raw, unguarded client (needed for `getScopedDb`'s own implementation, cron jobs iterating every organization, the kiosk's slug-to-organization resolution, and two public pre-auth pages) now lives behind an explicitly-named `unscopedPrisma` export (`src/lib/prisma/unscoped.ts`), not the default import.

**What the guard does NOT prove.** It checks that `organizationId` appears somewhere in a query's arguments — it does not check that the value is the CALLER's organization. A query carrying another organization's real id satisfies the guard just as well as the caller's own. That is still a large improvement: an unfiltered query, which is what all three real leaks below actually were, is now structurally impossible. But "no query can cross tenants" remains false as a blanket claim, and writing it down as true is exactly the mistake that produced revision 23's false backstop in the first place. The remaining protection against a wrong-but-present `organizationId` is `requireTenantContext`/`resolveActionContext`/`getScopedDb` deriving that id from a re-verified DB membership row keyed on the real, server-authenticated `userId` — never from trusting the value's mere presence. Swept for the gap this implies (a call site taking `organizationId` from a request parameter, form field, or cookie without that re-verification): every Server Action that accepts `organizationId` as an explicit argument (bound via `.bind(null, organizationId)` from an already-resolved page prop, and therefore technically resubmittable by a crafted request) calls `resolveActionContext(organizationId, ...)` as its first real statement, which re-validates the claim against a real `OrganizationMembership` row for the authenticated user before anything is trusted — confirmed for all 10 such action files, not assumed. Every plain helper function added in this revision that takes a bare `organizationId` parameter (`getAtBeltSummary`, `getCurrentPaymentPeriod`, `listClassSessions`, etc.) is called exclusively with an already-validated `context.organizationId`, never with unvalidated input — confirmed at every call site, not merely at the ones changed here.

**The number this revealed.** Attaching the guard and running the existing integration suite (410+ tests, all driving real application code through the same guarded singleton, not fixtures) failed **168 of 412 tests across 28 of 49 files** on the first run. That is not 168 bugs, nor is it 168 newly-discovered cross-tenant exposures — nearly all of it traced back to a small number of repeated shapes (a handful of "trusted-id read helper" functions called from a dozen call sites each, one shared promotion-writing transaction, a few analytics second-stage queries), and among the ~50 real call sites this produced, **zero were reachable cross-tenant today** — each was already preceded by a scoping check earlier in its own request. That is a distinct claim from "nothing was ever reachable cross-tenant": the layout leak, the unauthenticated signup page, and `getStaffSession()`'s cross-org `academyIds` merge (below) were all genuinely reachable, `signup/page.tsx` with no authentication at all, and all three were already fixed in this same revision before the guard ever ran. What the 168-test number adds is narrower but still real: it is the honest measure of how much of "no unfiltered query exists" had never actually been checked, for call sites that happened not to be exploitable only because of the order code currently calls them in — an order nothing enforced and a future change could easily invert.

Fixed in this revision: every one of those ~50 real call sites (added `organizationId` to the query, or threaded it through as a new parameter propagated to every caller), the three known leaks (`(staff)/layout.tsx`, `signup/page.tsx`, `getStaffSession()` — the last via deleting `StaffSession` entirely in favor of `TenantContext`, see Appendix C), a parallel, previously-undocumented gap in `resolveContext()` (never checked `User.active`, so a deactivated user kept a working tenant context for the life of their JWT — the same guarantee the deleted `getStaffSession()` gave the staff surface alone, now closed for every `TenantContext` caller), and a structurally identical parallel gap in `getStudentSession()`/`StudentSession` — deleted outright rather than patched, once confirmed to have zero real production callers (the portal had already migrated to `requireTenantContext(["STUDENT"])`; its own test file tested nothing else and was deleted alongside it). Three regression tests (`tests/unit/tenant-guard.test.ts`, `tests/integration/tenant-guard-transaction.test.ts`) reproduce the exact unscoped call shapes the layout leak and the signup-page leak actually sent, and the `$transaction` propagation question above, and assert the guard refuses all three, per the Global rule added in revision 23.

**Known limitation carried forward, not closed by this revision:** the `no-restricted-imports` ESLint rule that would make `unscopedPrisma` require an explicit allowlist entry could not be added — `eslint.config.mjs` is hard-blocked by this repository's own config-protection tooling. The exact rule, with its allowlist, is recorded in a comment at the top of `src/lib/prisma/unscoped.ts` for manual application. Until that lands, the import-ergonomics half of this fix (make the safe path the only easy one) is enforced by the runtime guard alone, not also by the linter.

## What changed in revision 23 — the Prisma "runtime backstop" was never attached to the base client

The third occurrence of the same pattern (1f; revision 22; now this), found while investigating an unrelated question about mid-session revocation. `src/app/[locale]/(staff)/layout.tsx` — the persistent shell every staff page renders inside — called `prisma.academy.findMany({...})` and `prisma.student.count({...})` directly from the raw client, with no `organizationId` filter, for every ADMIN session. Every academy name across every organization on the platform, and a platform-wide active-student count, rendered into the academy switcher and nav badge on every staff page load. Confirmed to be an information-disclosure leak (competitor academy names, cross-tenant business metrics) rather than a path to another organization's real student/attendance/payment records — no other page reads the leaking cookie to scope a real query — but a genuine tenant-isolation failure regardless, not a cosmetic one.

**Root cause, checked directly rather than assumed:** `src/lib/prisma.ts` exports a plain `new PrismaClient({adapter})` — no `$extends`, no query hooks. `getScopedDb()` (`src/lib/tenant/scoped-client.ts`) calls `prisma.$extends({...})`, which returns a **new, separate, derived client**; it never mutates the original. So what Phase 1's "as built" section (below) called "the Prisma extension is the runtime backstop beneath" the typed wrapper was never true in the sense that sentence implies: the extension protects only the one object `getScopedDb()` returns, not the base `prisma` singleton every file imports by default. Any file that imports `{ prisma }` directly and then touches a `TENANT_SCOPED_MODELS` entry — the *normal, ergonomic* thing to do — gets zero runtime protection. `check:guard-usage` did not catch it either, and structurally could not: its algorithm counts textual references to exported guard *names*; it has no notion of a call site's receiver, so "was this method called on the raw client or the scoped one" is not a question it can ask. Neither tool is buggy. Both do a smaller job than this document claimed.

Corrected below (Phase 1 "as built" and Appendix C decision 6) to state what is actually true. The fix — attaching the extension to the base client itself, with named escape hatches for the platform-level models and system jobs that legitimately need it — is tracked separately; this revision closes the documentation gap first, since the wrong sentence was actively producing wrong decisions.

## What changed in revision 22 — closed finding: no authenticated session had ever loaded a page

The 1f finding repeating, at a larger scale. `requireTenantContext()` treated a `null` `session.activeOrganizationId` as `NO_MEMBERSHIP` and redirected to `/login` — and `activeOrganizationId` was set to `null` on every sign-in (Appendix C decision 4's own `jwt` callback), with nothing anywhere in the app that ever set it to a real value outside the not-yet-built Phase 5 org switcher. Every real login for every user landed back on `/login`, indistinguishable from the outside from "the cookie doesn't work" — which is what it looked like across Phases 2d, 3b, and 3c-i's blocked screenshot attempts, and why a separate, real cookie bug (`signIn(..., {redirect:false})` inside a Server Action, fixed the same day) was mistaken for the whole story.

**Why the test suite never caught it:** every integration test that exercises `requireTenantContext`/`getTenantContext` constructs a `TenantContext` or mocks `auth()` directly with a session that already carries a real `activeOrganizationId` — none of them go through actual `signIn()` and a real browser session, because that requires a running HTTP server and cookie jar a plain Vitest test doesn't have. The "does the real path work" case had no test that could see it, by construction — the same blind spot the 1f finding named, just one layer up: the guard's own unit tests were fine, but nothing drove the real front door. Closed by: (1) fixing `signIn()`'s cookie-drop bug, (2) resolving `activeOrganizationId` at sign-in (`src/lib/tenant/active-organization.ts`, exactly-one-membership auto-selects, 2+ requires the explicit `/select-organization` screen, zero gets its own `/no-organization-access` page — never a silent fallback), (3) splitting `requireTenantContext`'s four failure shapes (`UNAUTHENTICATED` / `NO_MEMBERSHIP` / `NEEDS_ORGANIZATION_SELECTION` / `ORG_NOT_ACTIVE`) so "not authenticated" and "no tenant selected" can never collapse into the same redirect again, and (4) a dev-only session-minting bypass (`src/app/api/e2e-auth-bypass/route.ts`) proven, by a dedicated equality test, to produce the structurally identical session real login does — see KNOWN_LIMITATIONS in `scripts/pending-callers.ts` for why that bypass itself remains a standing risk worth re-reading before launch, not a substitute for testing the real path.

## What changed in revision 21

Three corrections from Alexis after seeing the rendered belts. The first two were spec errors, not implementation errors.

- **Tape colours: the third band is YELLOW on every kids belt**, not the belt's own colour. The source says "4 white, 4 red and 3 yellow"; the draft generalised that to "colour-match" and every 11-degree row inherited the mistake. Yellow, universally.
- **Split belts are a CENTRE STRIPE, not two halves.** A grey-white belt is a grey belt with a white band down the middle third — not 50% grey over 50% white. Modelled as `centerStripeColor`, not `isSplit` + `splitColor`.
- **Adult tapes are white.** Seeded black, which renders black-on-black and hides every adult student's degrees.
- **Kids → adult goes to BLUE at 16**, not white. `green_black` is the last kids rank; the transition's default destination is adult blue.

## What changed in revision 20

- **Phase 3 kids catalog table** renumbered to `order` 1–13. It still showed 0–12, contradicting revision 18's own ruling that order is 1-based and contiguous, and `validateTrackConfig` enforces the 1-based rule — so the table as written would have failed validation. Spec error, corrected.

## What changed in revision 19

- **Phase 2 — as built** (new section before Phase 3): sub-phases 2a–2d and the decisions that must not be quietly undone — the belt sequence coming from the catalog rather than a hardcoded array, the `writeAward` split, `AuditLog.actorId` nullability, and the automation job's shape.
- **Phase 3 verification:** the repo has no component-test harness, which is why one Phase 2 criterion closed by code reading. Phase 3 is far more visual — add `@testing-library/react` before starting, and split verification into machine-checked structure versus human-checked appearance.

## What changed in revision 18

Catch-up after Phase 1 shipped and Phase 2a began. The spec and the code had drifted apart; this closes the gap.

- **Phase 1 — as built** (new section before Phase 2): the 1a–1f sub-phases, the 1f audit finding that the enforcement layer was built but unused, and the resulting architecture. The wrapper is authoritative anywhere this document still implies manual per-call checks.
- **Global rules:** never generate a migration from a live database; the shadow database and the two-way `db:check-drift` are standing infrastructure; the pending-callers registry.
- **Phase 2:** `BeltRank`/`PromotionConfig` are strictly organization-owned (no per-branch override); mode values are preserved across mode switches; rank `order` is 1-based, aligning the spec to the implementation; superseding `eligibility.ts` requires a characterization test.
- **Appendix B question 1 closed** and moved to Appendix C: no branch overrides exist, and per-branch thresholds are semantically undefined under cross-branch attendance.

## What changed in revision 17

- **Global rules:** "disclose to members, never to non-members" — one rule covering every error-shape question. Cross-organization access returns `notFound`, never a distinct `forbidden`; a member of a suspended organization still gets its specific page. Refused attempts are logged and audited even though nothing is disclosed to the caller.

## What changed in revision 16

- **Global rules:** a guard is not done until the real request path goes through it. Three instances in this project of a mechanism that existed, passed its own tests, and was bypassed by the code that runs. Enforcement now requires a test driving the real route/action, and CI must fail on an exported guard with zero production call sites.

## What changed in revision 15

- **Appendix C decision 3** settled: `Notification.organizationId` is `NOT NULL`, and the reasoning for why it differs from `AuditLog`'s nullable column is recorded so the two are not "harmonized" later.

## What changed in revision 14

- **Phase 0 seed** is also the demo data — the director will test against it during development, so it uses plausible names and the academy's real schedule rather than obvious placeholders. Determinism unchanged.

## What changed in revision 13

- **Global rules** corrected — a stale line still claimed Alliance was live, contradicting the pre-launch rule two lines above it. Replaced with the real sequencing: Alliance is client #1 and receives nothing until the full feature set is done. Consequences made explicit: pre-launch, schema may be changed directly (reset and reseed rather than carry a compromised schema through eight phases); migrations get squashed into one initial migration before the first production deploy; the parity check is a regression net, not data protection; full migration discipline resumes at go-live.
- **Appendix A** records the launch sequencing and that the Phase 1 backfill will never run against real data.

## What changed in revision 12

- **Appendix C, decision 4** now carries an eight-point checklist the session/JWT/middleware proposal must answer before implementation — selector vs. authority, two tabs/two organizations, the kiosk on a browser with a live session, middleware not being the gate, platform admins without synthetic memberships, fail-closed on absence, revocation taking effect next request, and in-flight sessions.
- **Global rules:** phase numbers must be qualified with the document name (this repo holds two phased specs), and completion claims must cite evidence rather than assert.

## What changed in revision 11

- **Global rules** corrected: nothing is in production, development runs on local docker-compose Postgres, and the production database provider is **not chosen yet** — so no provider-specific code. The "must fit a free tier" constraint is replaced with "one person can operate it".
- **Phase 0** gains the dev-database cleanup (inventory first, reset on approval, stray databases/volumes listed not deleted), full test-database isolation requirements, the rule that QA logins live in the seed rather than being carried through a reset, a **seed safety guard** refusing any non-local target, and its own acceptance criteria.
- **Phase 4** logo storage reworded: the adapter exists to keep the provider choice reversible, not to fit a free tier.

## What changed in revision 9

1. **Phase 0 rewritten** — there is no production database yet. The baseline becomes a deterministic seed plus a repeatable seed → snapshot → migrate → snapshot → diff check in CI. Includes the corrected read-only enforcement (`SET TRANSACTION READ ONLY`, then verify) and the `.gitignore` requirement.
2. **Phase 3** — new *"Estado inicial"* section: students are entered manually at go-live, so the form must carry a prior-progress credit.
3. **Phase 8** — onboarding credits excluded from attendance analytics.
4. **Appendix C (new)** — the six architecture decisions from the Phase 1 discovery review, settled.
5. **Appendix A** — records that per-academy deployments were considered and rejected.

## What changed in revision 8

Four additions, placed in the phase that owns the work rather than appended at the end. If you reviewed revision 7, these are the only new sections:

1. **Phase 2** — a new *"Awarding from the student detail page"* subsection. The promotion queue stays; the student page becomes a second entry point to the same award functions.
2. **Phase 3** — *"Belt rendering"* now specifies a realistic woven-belt SVG. The tape derivation logic is unchanged; only the visual is replaced.
3. **Phase 4** — sidebar theming expanded from one color to a full, independently chosen sidebar palette.
4. **Phase 8 (new)** — attendance-by-class bar chart on the dashboard.

---

## 0. How to use this file

This document is the source of truth for a large feature set. **Do not implement it all in one pass.**

Work phase by phase. For each phase:

1. Re-read the phase section and the "Global rules" below.
2. Explore the existing code first (`prisma/schema.prisma`, migrations, seeds, auth/session helpers, kiosk handlers, attendance summaries, promotion actions) and write a short implementation plan before editing.
3. Implement, then run the verification commands.
4. Verify the phase's **Acceptance criteria** literally, one by one.
5. Stop and report. Do not start the next phase unless told to.

Suggested invocation: `Read docs/MULTI_ACADEMY_AND_KIDS_BELTS.md and implement Phase 1 only.`

### Phase order (each depends on the previous)

| Phase | Title |
|---|---|
| 0 | Capture the Alliance parity baseline (**before any migration**) |
| 1 | Tenant organizations above existing academy branches |
| 2 | Configurable promotion engine with Alliance compatibility |
| 3 | Kids belt catalog, track UI, and belt rendering |
| 4 | Per-organization branding (name, logo, theme colors) |
| 5 | Public organization registration + approval and invitations |
| 6 | Platform admin panel, audit, and authorization |
| 7 | Consolidated i18n, tests, and parity verification |
| 8 | Dashboard analytics — attendance by class |

---

## 1. Global rules (apply to every phase)

### Terminology — read this first

The existing `Academy` model represents a **physical branch**. Alliance Escazú and Alliance Escalante are separate `Academy` rows. Do not overwrite these rows or repurpose their existing `academyId` relationships as tenant identifiers.

| Term | Meaning | Scope |
|---|---|---|
| `Organization` | the SaaS tenant / business | tenant isolation boundary (`organizationId`) |
| `Academy` (existing) | a branch / sede within an organization | branch relationships (`academyId`, `homeAcademyId`) |

The UI may call an Organization an "Academia" and an Academy a "Sede". **Keep database terminology explicit** to avoid mixing tenant and branch scope.

Branding, signup, approval and SaaS administration operate on **Organization**. Kiosk tokens, class schedules and staff branch assignments stay on **Academy**. Anywhere the earlier draft said "Academy" meaning a tenant, read "Organization".

### Engineering constraints

- **Stack is fixed:** Next.js 15 App Router, TypeScript, Prisma 7 + Postgres, next-auth v5, next-intl, Tailwind v4 + shadcn/ui, luxon, recharts, vitest, pnpm. Do not introduce a new ORM, styling system, state library or auth provider.
- **Nothing is in production.** Everything in this repo is pre-launch. Development runs against a **local docker-compose Postgres** (`localhost:5432`); there is no cloud database, no deployment, and no real user data anywhere yet. Treat "production" in this document as a future state, not a running system.
- **The production database provider is not chosen yet.** Do not write provider-specific code, extensions or SQL. Plain Postgres that Prisma can talk to, so the choice stays open. Object storage, connection pooling and backups are deployment concerns to be decided when a provider is picked — not assumptions to bake in now.
- **Stay lean, but don't cargo-cult a free tier.** Keep infrastructure requirements modest: no separate worker service, no message queue, no third service to operate. Note for planning only: a commercial launch will need paid hosting regardless (Vercel's Hobby plan prohibits commercial use), so "must fit a free tier" is not a design constraint — "one person can operate it" is.
- **Alliance is client #1, not a pilot.** Nothing is handed to the academy until the full feature set is finished. There is no live deployment to protect, no irreplaceable data, and no user whose Monday morning a bad migration would ruin. Alliance Jiu-Jitsu Costa Rica (Escazú + Escalante) exists in this repo only as seeded fixture data.
- **Pre-launch, schema changes may be made directly.** The expand → backfill → constrain ceremony exists to migrate live data without downtime. There is no live data. Before go-live, if a later phase reveals that an earlier phase's schema was wrong, **change it** — drop the column, rename the model, restructure the relation — and reset and reseed. That is a two-minute operation, and it is cheaper and safer than carrying a compromised schema through eight phases because changing it felt irreversible. Do not invent backwards-compatibility constraints that no data requires.
- **Migration discipline still applies to the migration files themselves.** They must produce the correct final schema and run cleanly from empty. Plan to **squash all pre-launch migrations into a single initial migration immediately before the first production deploy**, so the production history starts clean rather than replaying the whole development archaeology.
- **The parity check is a regression net, not data protection.** Seed → snapshot → migrate → snapshot → diff proves a migration doesn't corrupt data. It is valuable for exactly that and should keep running after every phase. It is not guarding anything irreplaceable, and it must not be used to argue against a schema change that is otherwise correct.
- **Full migration discipline resumes at go-live.** From the first real academy onward, every rule that this section relaxes comes back: no destructive changes, expand/backfill/constrain, parity against a real production baseline taken beforehand.
- **No hardcoded tenant assumptions.** After Phase 4, any literal "Alliance", brand color or logo path in `src/**` is a bug.
- **Spanish + English.** Every new user-facing string goes through next-intl with both `es` and `en` messages.
- **Timezone:** all date math through luxon in the organization's timezone (default `America/Costa_Rica`). Never approximate a month as 30 days.
- **Qualify phase numbers with the document name.** This repo holds more than one phased spec (`docs/REDESIGN_BRIEF.md` has its own phases 0–9). Always write "MULTI_ACADEMY Phase 3" or "REDESIGN_BRIEF Phase 9", never a bare phase number, in code comments, commit messages and reports.
- **Disclose to members, never to non-members.** This single rule settles every "what error should this return" question in the project. A user who belongs to the organization is entitled to know its state — which is why a suspended organization's own director gets a specific localized page rather than a generic auth error. A user who does **not** belong to it is entitled to nothing, including the knowledge that a row exists: cross-organization access returns the same `notFound` a genuinely missing row returns, with no separate "forbidden" class and no new strings. Reads and writes must agree on this, or the disagreement between them is itself the disclosure channel. The unauthenticated kiosk is always treated as a non-member.

  Opaque to the caller, precise in the logs: every refused cross-organization attempt is logged server-side with actor, target organization and resource, and writes an `AuditLog` row. Declining to disclose something to a caller is not a reason to fail to record it.
- **A guard is not done until the path that actually runs goes through it.** Building a security mechanism and testing the mechanism proves nothing if the application bypasses it. This has now happened four times in this project: the read-only transaction guard was correct in `db-inventory.ts` and broken in `alliance-baseline.ts`; the Prisma tenant extension lives inside `getScopedDb()`, which (at the 1f finding) had zero callers, so the isolation suite tested a path production never executed; `requireTenantContext()` treated a `null` `activeOrganizationId` as "no membership" and sent every real login back to `/login`, a path none of its own unit tests could see because they all mocked a session that already carried an `activeOrganizationId` — the guard's logic was fine, the front door it was supposed to guard was unreachable; and, in Phase 4, a settings-page live contrast check compared `resolveSidebarTheme(...).foreground` to the raw override string that had seeded it — since an explicit override is returned verbatim (never re-derived), the two values are equal by construction whenever an override exists, so the check never called `contrastRatio` at all and silently reported every color as legible. Each of these looked like a real check to anyone reading the call site; none of them were exercised by a test that drove the actual path a user or director takes.

  Therefore: every enforcement mechanism needs a test that **drives the real route or server action** and observes the guard firing — not a test that calls the helper directly. And CI must fail on an exported guard with zero production call sites; a security helper that only its own test imports is dead code wearing a safety label. When reporting a guard complete, cite the call sites, not the helper.

  **A related, broader habit, not limited to security guards: this project repeatedly builds a mechanism and never wires it to the thing it was meant to affect.** Data layer: `getScopedDb()`, built and unit-tested, sat unused while every call site did its own manual check (1f). Auth layer: `requireOrganizationAccess()`, built to close the two-tab hole, was never called (1f) — as was `requireTenantContext()` failing open into an unreachable redirect loop (above). Styling layer: `--sidebar-primary`/`--sidebar-primary-foreground` were declared in `globals.css` and aliased to the brand color, but the active nav item in `staff-sidebar.tsx` hardcoded `bg-brand-gold`/`text-brand-gold-foreground` directly instead of referencing them — so a director's independently-chosen sidebar-active color would have silently done nothing, exactly the same shape as an unreached guard, just with no security consequence. When adding any mechanism meant to be consumed elsewhere — a guard, a wrapper, a CSS custom property, a config flag — grep for what actually reads it before calling the task done, not just for what the mechanism itself tests.

  **A fifth finding, one layer up from all four above: the student portal (`/portal`) returned a real 500 for every real student**, from the commit that added its week calendar (`0d42614`) until a real HTTP request against a real running server finally hit it. Root cause: `week-calendar.tsx` is `"use client"`, and its plain exported `rowFor()` function — pure row-placement arithmetic, no React or browser dependency at all — was imported and called directly by `portal/page.tsx`, a Server Component. Once a module has `"use client"`, every one of its exports becomes an opaque client reference to server code; calling one during SSR throws. Fixed by moving `rowFor`/`CALENDAR_START_HOUR`/`CALENDAR_END_HOUR` into a plain, directive-free sibling module (`week-calendar-grid.ts`) both the client component and any server page can import directly. The fix is the least important part of this finding: **every suite in this repo — 445 integration tests, 346 unit tests — constructs a context or mocks `auth()` directly; none of them render a single page through Next's real SSR pipeline.** Every page in this app could have been 500ing and the full suite would have stayed green. This is the same shape as the four guard findings above, generalized past guards to the application as a whole: this project's tests verify units in isolation and had, until now, verified almost nothing about whether the assembled application actually runs. Closed by `tests/smoke/page-routes.test.ts` (`pnpm test:smoke`, wired into CI): one real HTTP request per `page.tsx` route, through a real running server, with real minted sessions per role (via the same dev-only `e2e-auth-bypass` route Playwright/manual verification already used) — asserting nothing about content, only that the route doesn't come back with a 5xx. That is deliberately the whole test: it answers a question this repo could not previously answer at all.
- **A guard is not tested until something takes the unguarded path and fails.** Every guard needs, alongside its own unit tests, a test that reaches the protected resource WITHOUT going through the guard and asserts that this is impossible or rejected. "The guard works when called" is not evidence that the guard is reachable, is called, or cannot be gone around. Three tenant-isolation findings in this project (1f, revision 22, the layout leak) were all invisible to full green test suites for exactly this reason.
- **Claims need evidence, not assertions.** When reporting a phase complete, cite the test or file that proves each criterion. A guard described in prose is not a guard — the read-only transaction check in Phase 0 was wrong in one script and right in another for exactly as long as nobody demanded a test that attempts a write.

### Briefs are not ground truth

A brief's view of this repository may be incomplete or out of date. Every statement in a brief about what the code currently does — a function's behaviour, a role gate, an ordering, whether a test or harness exists — is a **hypothesis, not a fact**, and must be checked against the current checkout before anything is built on it. Only instructions ("do X", "don't build Y", "this is the acceptance bar") are authoritative.

Therefore, before building on any statement about current behaviour:

1. Verify it against the code and cite file:line for what you actually find.
2. If the brief is wrong, say so explicitly and quote both — what the brief claimed and what the code does. Do not silently build the corrected version; the reviewer needs to know the premise was wrong, because other parts of the brief may rest on it.
3. If a brief assigns a cause to an observed symptom (a screenshot, an error message), treat the cause as unverified. A screenshot establishes what was displayed, never why. Reproduce it and identify the sequence before accepting the diagnosis.
4. If a brief asserts that the user has already done something — pasted a config, added a credential, merged a PR — check it rather than assuming it. This has been wrong twice.

Record in this doc every instance where a brief's premise turned out to be wrong, the same way the "built it, never wired it" tally is kept. The count tells us whether the review loop is catching them or whether they are reaching the code.

**Tally: kept from this revision forward.** No instances logged yet under this heading — see each future revision's own section for entries as they're found.

### Verification commands

Add to `package.json`:

```json
"typecheck": "tsc --noEmit"
```

Run per phase: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Integration tests must use an **explicitly configured test database**. Never reset or seed the live database as part of verification. Verification scripts must require an explicit database target and must not connect to production or reset a database implicitly.

Create migrations in development with `prisma migrate dev`. Apply reviewed migrations to deployed environments with `prisma migrate deploy`. **Never** run `db push`, a database reset, or development migration commands against the live database.

**Never generate a migration from a live database.** The migration history plus `schema.prisma` is the source of truth; a database is a consequence of it. Generating from `--from-config-datasource` (or any live-URL diff) bakes whatever that database has drifted into straight into a committed migration, where it replays forever. A shadow database is configured (`SHADOW_DATABASE_URL`) precisely so `prisma migrate dev` can do this correctly — its earlier absence is what made the wrong method reachable.

`pnpm db:check-drift` gates CI and runs **two** comparisons independently:

| Comparison | Catches |
|---|---|
| `schema.prisma` ↔ migration history | a schema edited with no corresponding migration — silent until something replays from zero |
| migration history ↔ live database | a database modified outside the migration history |

The third pairing, schema ↔ live database, is the one that must never be used to *generate* anything.

**Pending callers.** A function built ahead of the phase that will call it goes in the pending-callers registry: symbol, the phase that wires it, one line of why. CI prints the list every run so it stays visible. This exists because "built it, never wired it" has happened repeatedly here; a tracked deferral with a named owner is a decision, an untracked one is an orphan discovered two phases later. Anything still listed when its phase closes is a finding, not a footnote.

---

## Phase 0 — Repeatable parity baseline

### There is no production database yet

The academy still runs on GymDesk. The app has no live deployment and no real student data; the only database is a local dev one containing test-fixture noise. So Phase 0 is **not** a production snapshot. Its purpose is to prove that every later migration is non-destructive, repeatably, in CI.

### Clean up the dev database first — and stop it refilling

The dev database currently holds roughly 9 academies and 845 users of test-fixture noise. Wiping it once only resets the clock; the cause has to be fixed in the same pass.

1. **Inventory before deleting.** Report row counts per model, and specifically what those academies and users are — creation dates, naming patterns, which look like generated fixtures versus anything entered by hand through the forms. Delete nothing until Alexis confirms. A few of those rows may be real test students he typed in himself.
2. **Reset on his go-ahead**, targeting the dev database **explicitly by URL**. Never an implicit `DATABASE_URL`, and never a command that could reach another database.
3. **Check for storage that isn't rows:** logo or image bytes written to the database during testing, orphaned notification rows, audit rows, stale kiosk attempts. These grow faster than student records and are easy to miss.
4. **Check for stray databases or volumes** left over from testing — extra docker volumes locally, and, once a cloud provider exists, any branches or projects created during testing. List them rather than deleting; Alexis removes cloud resources himself.
5. **Fix the root cause.** The integration tests import the app's Prisma singleton, which reads the same `DATABASE_URL` the dev server uses, so every run writes into the dev database. Fix it properly:
   - a separate `TEST_DATABASE_URL`, and a separate docker-compose Postgres service (or at minimum a distinct database name), so tests never share a database with the dev app;
   - the test setup resolves the target and **fails loudly** if it matches the dev URL or anything non-test — compare host **and** database name, not string equality, so a trailing slash or an extra query param cannot slip past;
   - tests do not reach the app's Prisma singleton implicitly; the test client is explicit;
   - tests clean up after themselves. One suite leaving 16,000+ notification rows behind makes every future inventory unreadable;
   - **a test for the guard itself**: point the setup at a fake dev-looking URL and assert it refuses to run.

### Deterministic seed

Write a seed with **fixed IDs and fixed dates — no randomness**, mirroring Alliance's *shape* rather than its data: two branches (Escazú, Escalante), a realistic student count, a realistic belt distribution (many white, few purple, one or two brown), and roughly a year of attendance.

It must deliberately contain the cases that break tenancy and promotion migrations:

- students who train at both branches;
- a student at max stripes awaiting a belt;
- a negative-delta manual adjustment;
- attendance on a class with `countsTowardPromotion: false`;
- a student with zero attendance;
- at least one student at every belt in the adult track;
- once Phase 3 lands, the same coverage for the kids track, plus a student carrying an onboarding credit.

**The seed is also demo data — make it presentable.** The director will be shown the app and will test with it during development, long before launch, running against this seed. So it must not read as a test fixture: use plausible Costa Rican names rather than "Estudiante Prueba" or `seed-student-001` as display text (stable internal IDs are fine and still required), the academy's real class schedule (Mon 6am GI / 12pm NO-GI / 6pm GI principiantes / 7pm GI avanzados; Tue 12pm GI / 6pm NO-GI / 7pm GI; Wed 6am GI / 12pm NO-GI / 6:30pm competición; Thu 12pm GI / 6pm NO-GI / 7pm GI; Fri 12pm NO-GI / 6:30pm GI; Sat 9am striking / 10am kids / 11am open mat), and belt and attendance distributions that look like a real academy. Determinism is unchanged — fixed IDs, fixed dates, no randomness. This costs nothing and makes every demo land better than a screen full of obvious placeholders.

**The QA accounts belong in the seed, not carried through the reset.** The hand-made demo logins (admin, director, instructor, student, qa-director, plus the linked student record) are recreated in the seed with fixed IDs and known dev credentials, so they survive every reset and are part of the reproducible fixture. Preserving rows around a reset would break determinism — they would not be in the seed, so the next reset would lose them and the snapshot diff would go red for reasons unrelated to any migration.

**Safety guard — the seed must refuse to run anywhere but local or test.** It creates accounts with known passwords. Resolve the target and abort loudly unless it is explicitly a local or test database. A seed like this reaching a real deployment is not a mess, it is a backdoor administrator account. Same class of guard as the test-database check above, and it gets its own test.

Reset the dev database to this seed. The existing fixture pollution is noise, not a baseline.

### Baseline script

`scripts/alliance-baseline.ts`, run with an explicitly passed target (`--database-url=` or a dedicated env var — never an implicit `DATABASE_URL`). It captures:

- row IDs and counts per model;
- branch ownership and relationships;
- each student's belt, degree count, and belt anchor;
- attendance delta totals per student (`SUM(AttendanceRecord.delta)`), promotion-relevant and total, replicating the existing attendance-summary filter rather than reimplementing the rule;
- payment amounts and statuses;
- staff branch access;
- dashboard totals as rendered;
- kiosk token hashes and student code hashes.

**Read-only enforcement:** issue `SET TRANSACTION READ ONLY` as the first statement of the transaction, **before any data query** — `SET LOCAL default_transaction_read_only` sets the default for *subsequent* transactions and does nothing to the one already open, so it is not a guard. Then verify by querying `SHOW transaction_read_only` and abort loudly if it is not `on`. Never proceed unverified.

**Never commit a real baseline.** `baselines/` goes in `.gitignore`; a snapshot contains student names and code hashes. Verify no baseline file is already tracked in git before proceeding — if one was ever committed, report it rather than quietly deleting it. The *synthetic* seed snapshot is committable, but it lives under a clearly separate path so the two can never be confused.

### The check that actually runs

Wire it as CI: **seed → snapshot → migrate → snapshot → diff.** Any unexpected difference fails the build. Run it after every phase — Phase 7 consolidates verification, it is not the first time these checks run.

### The production baseline still happens

Keep the script and its explicit-target interface. The real snapshot is taken **immediately before the first migration after go-live**, against production data, once there is any.

### Acceptance criteria

- [ ] A dev-database inventory was reported and approved before anything was deleted.
- [ ] The dev database contains only the deterministic seed — no leftover fixture academies, users, logo bytes, notifications, audit rows or kiosk attempts.
- [ ] Stray databases/volumes from testing are listed for Alexis, not deleted by the agent.
- [ ] Integration tests target their own configured database, and the test setup fails loudly if the target resolves to the dev URL or anything non-test — asserted by a test that points it at a fake dev-looking URL.
- [ ] The integration suite leaves no residue: running it twice in a row produces the same row counts.
- [ ] The seed refuses to run against a target that is not explicitly local or test — asserted by a test.
- [ ] The QA/demo logins exist in the seed with fixed IDs and survive a reset; their credentials are documented in the repo as dev-only.
- [ ] Re-running the seed twice produces byte-identical snapshots (it is deterministic: fixed IDs, fixed dates, no randomness).
- [ ] The seed contains every listed edge case, verified by assertions rather than by eye.
- [ ] The baseline script issues `SET TRANSACTION READ ONLY` before any data query and aborts if `SHOW transaction_read_only` is not `on` — proven by a test that attempts a write inside the transaction and expects it to fail.
- [ ] The script refuses to run without an explicitly passed target; it never reads `DATABASE_URL` implicitly.
- [ ] `baselines/` is in `.gitignore`, and `git log` confirms no baseline file was ever committed.
- [ ] CI runs seed → snapshot → migrate → snapshot → diff and fails on any unexpected difference.

---

## Phase 1 — Tenant organizations above existing academy branches

### Goal

Introduce isolated SaaS tenants while preserving Alliance's existing branches, student records, attendance, payments, staff assignments, kiosk tokens, and dashboard totals.

### Repository discovery

Before editing:

1. Read `prisma/schema.prisma`, migrations, seed data, authentication/session helpers, kiosk handlers, attendance summaries, and promotion actions.
2. Inventory every model and classify it as:
   - organization-owned;
   - branch-owned, also organization-scoped;
   - global identity/authentication;
   - platform-level operational data.
3. Inventory routes, server actions, jobs, caches, and public handlers that access those models.
4. Produce a migration mapping from existing fields to the proposed schema.
5. Capture an Alliance baseline before applying any migration (Phase 0).

Do not connect verification scripts to production or reset a database implicitly. Require an explicit database target.

### Organization model

Add an `Organization` model with:

- id;
- unique slug;
- name and optional shortName;
- status: `PENDING | ACTIVE | SUSPENDED | CANCELLED`;
- timezone and default locale;
- contact details;
- internal notes;
- createdAt, updatedAt, approvedAt, approvedById.

Add `organizationId` to existing `Academy` rows.

Seed one ACTIVE Organization:

- slug: `alliance-cr`
- name: Alliance Jiu-Jitsu Costa Rica
- timezone: `America/Costa_Rica`
- locale: `es`

Attach both existing Alliance branches to this organization while preserving their IDs, names, slugs, kiosk token hashes, and existing relationships.

### Tenant-owned data

Add `organizationId` to tenant-owned domain models, including `Student`, `ClassSession`, `AttendanceRecord`, `Promotion`, `PaymentPlan`, `PaymentPeriod`, `KioskAttempt`, and `StaffAssignment`.

Preserve existing branch fields:

- `Student.homeAcademyId`;
- `ClassSession.academyId`;
- `AttendanceRecord.academyId`;
- and other existing branch relationships.

Database constraints must prevent relationships across organizations:

- a student's home branch belongs to the same organization;
- attendance references a student and branch in the same organization;
- a referenced class session belongs to the attendance branch;
- payment plans and student payments belong to the same organization;
- promotions reference students and ranks in the same organization.

Use composite foreign keys or equivalent database constraints where needed. Document which constraints are enforced by the database and which require application authorization.

Cross-branch attendance within the same organization remains supported. **Do not require an attendance branch to equal a student's home branch.**

### Users and permissions

Keep `User` as the global login identity with globally unique email. Do not add a mandatory tenant identifier to every authentication model.

Introduce organization membership so one user can hold access to more than one organization without duplicate login identities.

Use organization membership for ADMIN/DIRECTOR/INSTRUCTOR/STUDENT access. Preserve existing branch assignments for location restrictions.

`SUPER_ADMIN` is an explicitly granted platform role. It must not be inferred from a client-submitted email, registration form, or editable profile field.

Existing ADMIN access to all Alliance branches becomes organization-wide Alliance access. **Do not automatically promote every existing ADMIN to SUPER_ADMIN.**

Explicitly provision Alexis's platform access through a controlled, documented bootstrap operation.

Preserve existing promotion authorization:

- ADMIN and DIRECTOR may award promotions.
- INSTRUCTOR may view eligible students within their assigned scope.
- Instructor awarding is out of scope unless separately approved.

### Tenant context and data access

Create a server-only tenant context containing:

- actorUserId;
- organizationId;
- organization role;
- permitted branch IDs, or organization-wide branch access;
- impersonation state, if applicable.

An authenticated request must validate organization membership and current organization status. **A selected organization ID from a cookie, URL, or form is a selector, not proof of authorization.**

Missing tenant context must **fail closed** for tenant-owned data access.

Implement a centralized, enforced data-access boundary. Do not assume a Prisma extension automatically protects every query shape. Explicitly cover or reject:

- reads, including `findUniqueOrThrow` and `findFirstOrThrow`;
- aggregates and `groupBy`;
- create/update/delete and their bulk variants;
- `upsert`;
- nested writes and relation `connect` operations;
- transactions;
- raw SQL.

Tenant predicates must not be overridable by caller input.

Keep a narrowly controlled platform/global data-access module for:

- authentication and membership resolution;
- platform administration;
- public organization registration;
- organization discovery for public pages and kiosk tokens;
- migrations and seeds;
- authorized cross-organization job dispatch.

Public discovery must return only the fields needed for that public surface. Public registration access must not become a general unscoped query path.

Add import restrictions and tests around this boundary.

Tenant isolation does not replace branch permissions or student self-access.

### Kiosk

Preserve the existing hashed branch kiosk tokens and hashed student codes.

Resolve the branch from its verified kiosk token, then derive its organization. Resolve student codes within that organization.

Replace global student code-hash uniqueness with organization-scoped uniqueness, preserving the current hashing mechanism.

Do not store plaintext student codes.

Preserve existing class matching and kiosk lockout behavior.

#### Suspended organization policy (decided)

When an organization is `SUSPENDED`, kiosk requests must **reject check-ins server-side** and display a localized message:

> **es:** "El registro de asistencia no está disponible temporalmente. Por favor contactá a tu academia."
> **en:** "Check-in is temporarily unavailable. Please contact your academy."

Rules:

- Rejection is enforced in the kiosk handler on the server, before student-code resolution. A hidden button or a client-side check is not enforcement.
- The message is generic on purpose: it must not disclose billing state, the organization's status value, or whether a submitted code was valid.
- Existing attendance remains intact. Nothing is deleted, hidden, or recalculated on suspension.
- Reactivation restores access using the **existing kiosk tokens**. Do not rotate or reissue branch tokens on suspend/reactivate.
- The same rule applies to `PENDING` and `CANCELLED` organizations.
- **Payment grace periods do not change organization status to `SUSPENDED`** — see "Organization billing status and grace period" in Phase 6. An organization inside its grace window is still `ACTIVE` and its kiosk works normally.

### Migration and verification

Use an expand/backfill/constrain migration sequence:

1. Add the Organization model and nullable organization references.
2. Create the Alliance organization.
3. Assign existing branches to Alliance.
4. Derive each domain row's organization from its existing relationships.
5. Fail on missing or inconsistent ownership; do not guess.
6. Verify the backfill.
7. Add non-null constraints where applicable, indexes, and relationship constraints.
8. Replace only the uniqueness constraints that need tenant scoping.

Global identities and platform-level records are explicit exceptions to the non-null organization requirement.

Verification must compare the Phase 0 baseline with post-migration data:

- existing row IDs and counts;
- branch ownership and relationships;
- student belts and stripes;
- attendance delta totals;
- payment amounts and statuses;
- staff branch access;
- dashboard totals;
- kiosk token hashes and student code hashes.

### Acceptance criteria

- [ ] Existing Alliance branch IDs and relationships are preserved.
- [ ] All tenant-owned rows have valid organization ownership.
- [ ] Existing Alliance pages show the same data and totals.
- [ ] Organization A cannot read or mutate Organization B through any exposed route, action, export, or job.
- [ ] Cross-organization relation connections are rejected.
- [ ] Instructor branch restrictions and student self-access are preserved.
- [ ] Identical student PINs may exist in different organizations without cross-matching.
- [ ] Existing Alliance kiosk tokens continue to resolve their original branches.
- [ ] A kiosk check-in against a SUSPENDED organization is rejected server-side with the localized generic message, in both locales, and reveals nothing about billing state or code validity.
- [ ] Reactivating that organization restores kiosk check-in with the same unrotated branch token, and its prior attendance rows are unchanged.
- [ ] Missing tenant context fails closed.
- [ ] Typecheck, lint, relevant tests, and build pass.

---

### Phase 1 — as built

Phase 1 was executed in sub-phases that this document did not originally name. Recorded so the spec and the code do not describe different architectures:

| Sub-phase | What shipped |
|---|---|
| 1a | Expand: `Organization`, nullable `organizationId` everywhere, backfill script (proven on a simulated pre-migration state; it will never run against real data — see Appendix A) |
| 1b | Constrain: non-null, composite FKs, organization-scoped `codeHash` uniqueness |
| 1c | Tenant context, `getScopedDb` wrapper, Prisma extension, per-operation-shape isolation suite |
| 1d | Call-site migration off `academyScopeWhere` |
| 1e | Kiosk organization resolution, suspended-organization behavior, cross-tenant isolation suite |
| 1f | **Remediation**, added after an audit found the enforcement layer was built but unused |

**The 1f finding is the important part of this record.** After 1a–1e reported complete, an audit found that `getScopedDb` had zero callers: the extension sat off the request path, every call site did its own manual `organizationId` check, and the isolation suite exercised an abstraction production never executed. `requireOrganizationAccess` — built to close the two-tab hole — was likewise uncalled, with actions reading the ambient cookie instead.

1f fixed both and added the structural defense: **`check:guard-usage`**, a CI check that fails on an exported enforcement helper with zero production call sites. It immediately found and removed two more dead guards. Scope is deliberately limited to enforcement helpers (`src/lib/tenant/**`, `src/lib/auth/**`, plus `require*`/`assert*`/`ensure*`/`is*Allowed`) — a dead guard gives false safety, a dead feature is merely untidy, and conflating the two produces arguments rather than safety. **`check:guard-usage` cannot see the failure mode revision 23 found** (below): it counts textual references to an exported guard's *name*; it has no notion of a call site's receiver, so it cannot ask "was this Prisma call made on the raw client or the scoped one." That is a different, still-unbuilt check, not a gap in this one.

**The enforcement architecture as built, corrected in revision 23:** the typed wrapper (`getScopedDb`) is the intended access path, and `check:guard-usage` does prove every exported guard has a real caller — but the Prisma extension is **not** a backstop beneath the wrapper the way that phrase implies. `getScopedDb()`'s call to `prisma.$extends({...})` returns a new, separate, derived client; it never mutates the base `prisma` singleton exported from `src/lib/prisma.ts`, which remains a plain, completely unguarded `PrismaClient` forever. Any file that imports `{ prisma }` directly — the normal, ergonomic import — and then queries a `TENANT_SCOPED_MODELS` entry bypasses tenant scoping entirely, with nothing to stop it and nothing to notice it happened. `src/app/[locale]/(staff)/layout.tsx` did exactly this (revision 23). Anywhere this document still implies the extension is attached to the base client, or that it catches an unscoped query regardless of which import a file used, that is the error being corrected here.

---

## Phase 2 — Configurable promotion engine with Alliance compatibility

### Goal

Support `ATTENDANCE`, `TIME`, `HYBRID`, and `MANUAL` promotion modes while preserving Alliance's existing cumulative attendance behavior.

Extend the existing:

- `BeltRequirement` configuration;
- attendance-summary and eligibility logic;
- `Promotion` history;
- `AuditLog`;
- promotion queue;
- transactional promotion action.

**Do not create a second independent promotion-history system.**

### Existing behavior that must remain unchanged

Alliance counts promotion-relevant attendance since `Student.beltAwardedAt`.

The attendance total is `SUM(AttendanceRecord.delta)`, **not a row count**.

Manual adjustments count. Attendance linked to a class with `countsTowardPromotion: false` does not count toward promotion progress.

**Stripe awards do not reset the attendance anchor.**

For a student with S awarded stripes and a per-stripe requirement R:

- next stripe threshold = `(S + 1) × R`;
- belt threshold = `maxStripes × R + extra belt requirement`.

Example: a white-belt student has 47 eligible attendances and receives their first stripe. They retain 17 attendances of progress toward stripe two. **Resetting progress to zero at that award would be a regression.**

Belt awards reset the belt attendance anchor, as the current app does.

### Configuration and ranks

`PromotionConfig` and `BeltRank` belong to Organization.

Seed Alliance adult requirements:

- white: 30 per stripe, 4 stripes, 30 extra for belt;
- blue: 65 per stripe, 4 stripes, 65 extra for belt;
- purple: 75 per stripe, 4 stripes, 75 extra for belt;
- brown: 85 per stripe, 4 stripes, 85 extra for belt;
- black: terminal, 0 stripes, no automatic progression.

**`BeltRank` and `PromotionConfig` are strictly organization-owned — no per-branch override column.** Settled during the Phase 2a review, and the reason is coherence rather than cost: students train at either branch and their attendance pools into a single progression, so a per-branch threshold has no defined meaning for anyone training at both, which is the normal case. The old `BeltRequirement.academyId` fallback was never written to — no UI, no action, no row, ever — and it is dropped rather than carried forward. If a real customer ever asks for per-branch rules, design it then, against an actual requirement.

**Mode values are preserved across mode switches.** A rank carries both the attendance thresholds and the month thresholds. Validation requires the *active* mode's fields to be present and positive; it must never require or encourage clearing the other mode's values. A director who tries `TIME` for a month and reverts gets their attendance numbers back rather than a blank form — nullable means "never configured", not "not currently in use".

**Rank `order` is 1-based and contiguous.** (The first draft said 0-based; the implementation chose 1-based and the spec is aligned to it.)

Migrate `currentBelt` enum values to organization-owned rank references using an explicit mapping. Preserve every student's belt and degree count.

Introduce `Student.track` **in this phase**, with existing students set to `ADULT`. Phase 3 adds the kids UI and catalog.

Validate configuration:

- integer `maxStripes >= 0`;
- positive integer attendance requirements when applicable;
- positive integer calendar-month requirements when applicable;
- `stripeColors` length equals `maxStripes`;
- `visibleStripeSlots` is a positive integer;
- unique rank order and code within organization and track;
- explicit terminal-rank behavior.

Terminal ranks may award remaining degrees if configured to do so. After their final degree, `nextTarget` is `NONE`.

### Engine

Keep the calculation core pure and unit-testable.

Supply enough information to determine:

- the active rule mode;
- the student's current rank and degree count;
- whether a next rank exists;
- cumulative promotion-relevant attendance since the belt anchor;
- the applicable time anchor and evaluation date;
- the effective configuration.

Return:

- `nextTarget`: `STRIPE | BELT | NONE`;
- required and current progress values;
- remaining attendance and/or due date;
- `percent`, clamped to 0..100;
- `isEligible`.

**ATTENDANCE** — use cumulative belt attendance and the thresholds above.

**TIME** — calculate the due date using Luxon calendar-month addition in the organization timezone. Do not approximate a month as 30 days.

**HYBRID** — both attendance and time requirements must be satisfied.

**MANUAL** — report the next target for display but never mark automatic eligibility.

**Superseding `eligibility.ts` must be proven, not asserted.** Before deleting it, write a characterization test running the old module and the new engine against the same input matrix — every belt, stripe counts 0..max, attendance around each threshold boundary, negative deltas, non-promotion classes — asserting identical output. Keep the old module until that test is green. "Preserved the semantics" is exactly the class of claim that has been wrong repeatedly in this project; running both implementations against the same inputs is the only version of it that can be checked.

Invalid configuration must produce an explicit configuration error. **Do not silently turn invalid requirements into automatic eligibility.**

Negative attendance totals can result from adjustments. Preserve the ledger, show zero percent progress, and calculate eligibility from the actual total.

### Time-mode semantics

The first time-based interval starts at the student's configured belt/time anchor. Each awarded promotion begins a new time interval at its award time.

A delayed time-based award does not automatically award several degrees.

Keep time anchors separate from cumulative attendance accounting. Adding TIME support must not reset Alliance attendance progress.

When switching modes, require the settings UI to state and confirm the time anchor used for students who do not already have one.

### Awarding

Eligibility calculation never changes a student's rank or degrees.

All awards go through centralized server-side award functions that:

1. Verify current actor permissions and organization/branch scope.
2. Verify the student and organization are active.
3. Revalidate current student state and applicable eligibility.
4. Update the student, append `Promotion` history, and append `AuditLog` within one transaction.
5. Reject conflicting or duplicate requests without partial writes.

Preserve the existing concurrent-award protection and strengthen it as needed for the new configuration and automatic jobs.

Use idempotency protection for retries and automatic job execution.

Attendance corrections and configuration changes racing an award must not allow an award based on an inconsistent snapshot.

Stripe awards retain cumulative attendance since the belt anchor. Belt awards reset the belt anchor. Attendance rows are never deleted or decremented by promotion operations.

### Approval and automation

When `requiresCoachApproval` is true:

- eligibility appears in the existing promotion queue;
- only ADMIN/DIRECTOR may confirm awards.

When false:

- authenticated scheduled jobs may award eligible stripes;
- belt awards still require ADMIN/DIRECTOR confirmation;
- each job processes bounded batches;
- retries are idempotent;
- each student receives at most one automatic stripe per scheduled daily run.

Use a trusted job credential and derive tenant context for each organization. Skip non-active organizations.

Record automatic awards with an explicit system actor/source. **Do not invent a human `awardedBy` user.**

### Awarding from the student detail page

The promotion queue ("Cola de promociones") stays exactly as it is — it answers *"who is ready right now?"*. But the other natural moment to promote someone is while looking at that student, so the student detail page gets a **Promociones** card as a second entry point to the same logic.

**It is an entry point, not a second system.** The card calls the same centralized award functions defined above. No parallel award path, no client-side eligibility treated as authoritative, no duplicated threshold math. The server revalidates permissions, organization/branch scope, student state and eligibility on every call, exactly as it does for the queue.

The card shows:

- the belt graphic at card size, with the true degree count beside it;
- the next target (`STRIPE` / `BELT` / `NONE`) and progress toward it — for `ATTENDANCE`, the cumulative count and the threshold with what remains ("47 / 50 · faltan 3"); for `TIME`, the due date; for `HYBRID`, both, with the binding one marked; for `MANUAL`, a plain statement that promotion is at the coach's discretion;
- **why** the student is not eligible, when they aren't. Never a disabled button with no explanation — "faltan 3 asistencias" or "próximo grado el 15 de octubre" is the whole point of the card;
- the promotion history for this student: date, rank, degrees, awarded by, `AUTO`/`MANUAL` source, and note.

Actions, strictly following the existing authorization rules — **this card must not widen them**:

| Role | Sees the card | Award / correct |
|---|---|---|
| ADMIN, DIRECTOR | yes | yes, within their organization |
| INSTRUCTOR | yes, read-only, within their assigned branch scope | no — no action buttons rendered, and the server rejects the call regardless |
| STUDENT | their own progress only, read-only | no |

Interaction rules:

- The award button is enabled only when the student is eligible, **except** the manual promote/correct actions from the section below, which are always available to ADMIN/DIRECTOR with a required note.
- **No optimistic UI for awards.** Show a pending state, wait for the server, re-render from server state. A double-click, a slow network retry, or an award raced against the queue must produce exactly one promotion — the idempotency and concurrency protection above is what guarantees it, and the card must not bypass it.
- After a successful award the card re-renders from the server: new degree count, updated belt graphic, new history row, recomputed next target.
- If the award is rejected because state changed underneath (someone awarded from the queue a second earlier), show what happened and the current state — never a generic error, and never silently retry.

### Manual corrections

ADMIN/DIRECTOR may manually promote or correct a mistaken promotion with a required note.

Preserve the original history. Append a correction event with before/after rank, track, degrees, and anchor values.

Correction workflows must explicitly determine the resulting anchors. Do not infer them silently.

### Rule changes

For v1, editing thresholds immediately recalculates eligibility using existing attendance and anchors. It does not directly alter awarded belts or degrees.

Use this warning:

> "Changing these rules recalculates current progress and may change who is eligible. Existing belts and degrees remain unchanged. Automatic stripe awards, if enabled, may occur on the next scheduled run."

Audit configuration changes with before/after values.

Reject reductions of `maxStripes` below any affected student's current degree count. Require an explicit migration/correction workflow for such changes.

### Acceptance criteria

- [ ] Every existing Alliance student's belt, stripes, attendance progress, and eligibility match the Phase 0 snapshot.
- [ ] A first stripe awarded at 47 white-belt attendances leaves 17 attendances toward stripe two.
- [ ] Signed attendance adjustments and non-promotion classes behave exactly as before.
- [ ] Black remains terminal with zero seeded stripes.
- [ ] Cross-branch Alliance attendance retains its existing behavior.
- [ ] Tests cover all modes, terminal ranks, invalid configuration, negative attendance, month-end boundaries, and delayed awards.
- [ ] Concurrent and retried awards produce one successful transition and one corresponding history event.
- [ ] Unauthorized instructors cannot award promotions.
- [ ] Every successful award and correction has transactional history and audit records.
- [ ] The student-page Promociones card and the promotion queue call the same award function — a single implementation, asserted by there being one award path in the codebase.
- [ ] An instructor opening a student in their branch sees the card with progress and no action buttons, and a direct server-action call from that account is rejected.
- [ ] An ineligible student's card states the specific reason (remaining attendances, due date, or manual mode) rather than only disabling the button.
- [ ] Awarding the same student from the queue and the card at the same moment produces exactly one promotion and one history row; the loser sees the current state, not a generic error.
- [ ] Double-clicking the award button produces one promotion.

---

### Phase 2 — as built

Executed as 2a–2d. Recorded so the spec and the code don't drift apart.

| Sub-phase | What shipped |
|---|---|
| 2a | `BeltRank` + `PromotionConfig` schema, `currentBelt` enum → rank references, `Promotion.awardedById` nullable + `source` discriminator, config validation and `updateTrackConfig` |
| 2b | The pure engine (`evaluatePromotion`), all four modes, plus a 103-case characterization test against the old module |
| 2c-i | Calculation core migrated onto the engine; `PromotionConfig` resolved once per batch, not per student |
| 2c-ii | `awardPromotion` centralized; `eligibility.ts`, its test, the characterization test and the legacy vocabulary all deleted in one commit |
| 2c-iii | The automatic stripe-award cron job |
| 2d | The student-detail Promociones card and manual corrections |

**Decisions that must not be quietly undone:**

- **The belt sequence comes from data.** `resolveNextRank` queries the catalog for `order + 1` within the organization and track. The old hardcoded `BELT_ORDER` array (white→blue→purple→brown→black) was only ever correct for Alliance's catalog and is flatly wrong for the 13-rank kids track. If a next rank is missing at a `BELT` target, `awardPromotion` throws `InvalidPromotionConfigError` naming the rank and order — `isTerminal` and "a rank exists at order+1" are different facts, and only validation keeps them aligned, so the guard stays.
- **One write, two callers.** `writeAward` holds the transactional write (Promotion + scoped Student updateMany + AuditLog); `awardPromotion` (manual, real `awardedById`) and the automation path (`AUTO`, `awardedById: null`) each keep their own read/validate shape. Both use the same `updateMany` scoped by id + status + exact from-rank + from-stripes; a zero-row match is a clean skip, never an error or a same-run retry.
- **`AuditLog.actorId` is nullable** so a system actor can be recorded honestly. It exists because "never invent a human `awardedBy`" collided with a required FK — the fix was the schema, not a fabricated user.
- **Automation never awards a belt.** Only `STRIPE` targets, and only when `requiresCoachApproval` is false. Belt-eligible students still appear in the promotion queue regardless of that setting — otherwise turning approval off would make belts silently never happen.
- **Job shape:** `CRON_SECRET` bearer check before anything else; idempotency is persistence-backed (no `AUTO` promotion for that student since start-of-day **in the organization's own timezone**, not the app-wide constant); candidates ordered by oldest `beltAwardedAt` so bounded batches drain instead of starving the tail; `batchSize` a parameter so the drain is testable at n=3; per-organization error isolation.
- Alliance runs `requiresCoachApproval: true`, so the automation is a no-op against the only real academy in the seed. A scratch approval-off organization in the test suite is its only coverage — keep it.

**Known limitations live in `scripts/pending-callers.ts`**, printed by CI every run: the hardcoded `APPROACHING_THRESHOLD` of 5, `progression.ts`'s ATTENDANCE-only projection, the log-only skipped-student count, and the HYBRID progress line concatenating both dimensions rather than naming the binding one. Each names the phase that should resolve it.

**One acceptance criterion closed by code reading rather than a test:** that an ineligible student's card states the specific reason. There is no component-test harness in this repo — see the note in Phase 3's verification section, which needs one.

---

## Phase 3 — Kids belt catalog, track UI, and belt rendering

### Student fields

`Student.track` already exists from Phase 2 — **do not add it twice**.

Reuse the existing `Student.dateOfBirth` rather than adding a `birthDate` field. Preserve `guardianName`, `guardianPhone`, and `emergencyContact`.

In the **Add student** and **Edit student** forms, add a required track control using the existing shadcn components:

> **Tipo de estudiante / Student type** → `Adulto (Adult)` | `Niño (Kid)`

Behavior:

- Selecting the track filters the rank dropdown to that track's ranks for the student's organization.
- Changing an existing student's track requires **explicit selection of the destination rank, degree count, and anchor policy**. Record the transition in the existing `Promotion` history and `AuditLog`. Never infer anchors silently.
- Default on create: first rank of the chosen track, 0 degrees, belt anchor = join date.
- Student lists, filters and the director dashboard gain a kids/adults filter; the dashboard counts kids and adults separately.

### Estado inicial — entering students who already have a rank

Students are entered **manually** at go-live; there is no GymDesk importer. That moves a real problem into the add-student form.

A student typed in as "blue belt, 2 stripes" has no attendance history in the app. In `ATTENDANCE` mode progress is the sum of deltas since the belt anchor, so the anchor date rescues nothing — their count is zero whatever date is set, and a brown belt who was 80 attendances into his fourth stripe opens the app at 0/85. That is the first thing the director will notice.

Add an optional **"Estado inicial"** section to the add-student form, shown when the student is not starting from scratch:

- current rank and degrees (already present via the track selector);
- date of last promotion → `beltAwardedAt`;
- **asistencias acumuladas hacia el próximo grado** — an integer credit, **defaulting to 0**.

On save, create the student at that rank and write **one** manual attendance adjustment carrying the credit, with a distinct reason (`onboarding_credit`) and a note naming who entered it.

**The credit counts toward promotion but is excluded from attendance analytics.** Nobody walked through a door. It must pass the promotion-relevant filter that the engine sums, and it must be excluded from the weekly trend and the attendance-by-class chart (Phase 8) — otherwise the dashboard opens with a phantom spike on go-live day and a class breakdown that never reconciles again. This needs its own flag; do not infer it from the adjustment reason string at query time.

The credit stays visible and correctable: it appears in the student's attendance history as "crédito inicial", not buried in the ledger, and a director can edit it when the coach says the number was wrong.

Defaulting to 0 is deliberate — crediting prior progress is the director's decision, per student, and a clean slate ("el conteo empieza hoy") is a legitimate choice.

Optional, worth offering if the roster exceeds ~50 students: a bulk-add screen accepting pasted rows (name, belt, degrees, credit) with a review step before committing.

### Kids belt catalog — Alliance preset

This table is the **selected Alliance kids preset**. Do not claim its exact degree counts are mandatory official IBJJF rules without verifying the current official source. Record the verification source and date before publishing that claim anywhere user-facing or in sales material.

Seed as `BeltRank` rows with `track: KIDS`, owned by the organization.

| order | code | label (es / en) | belt | centre stripe | maxStripes | tape colors (degree 1→n) | age hint |
|---|---|---|---|---|---|---|---|
| 1 | `white` | Blanco / White | white | — | 5 | 4× white, 1× red | 4–15 |
| 2 | `grey_white` | Gris y Blanco / Grey-White | grey | white | 5 | 4× white, 1× red | 4–6 |
| 3 | `grey` | Gris / Grey | grey | — | 11 | 4× white, 4× red, 3× yellow | 4–6 |
| 4 | `grey_black` | Gris y Negro / Grey-Black | grey | black | 11 | 4× white, 4× red, 3× yellow | 4–6 |
| 5 | `yellow_white` | Amarillo y Blanco / Yellow-White | yellow | white | 11 | 4× white, 4× red, 3× yellow | 7–9 |
| 6 | `yellow` | Amarillo / Yellow | yellow | — | 11 | 4× white, 4× red, 3× yellow | 7–9 |
| 7 | `yellow_black` | Amarillo y Negro / Yellow-Black | yellow | black | 11 | 4× white, 4× red, 3× yellow | 7–9 |
| 8 | `orange_white` | Naranja y Blanco / Orange-White | orange | white | 11 | 4× white, 4× red, 3× yellow | 10–12 |
| 9 | `orange` | Naranja / Orange | orange | — | 11 | 4× white, 4× red, 3× yellow | 10–12 |
| 10 | `orange_black` | Naranja y Negro / Orange-Black | orange | black | 11 | 4× white, 4× red, 3× yellow | 10–12 |
| 11 | `green_white` | Verde y Blanco / Green-White | green | white | 11 | 4× white, 4× red, 3× yellow | 13–15 |
| 12 | `green` | Verde / Green | green | — | 11 | 4× white, 4× red, 3× yellow | 13–15 |
| 13 | `green_black` | Verde y Negro / Green-Black | green | black | 11 | 4× white, 4× red, 3× yellow | 13–15 |

All kids ranks seed `visibleStripeSlots: 4`. `maxStripes` is the **degree counter**, not the number of tapes drawn — see "Belt rendering".

**Alliance kids rule:** `attendancePerStripe = 10` on every kids rank, `extra belt requirement = 10`. Thresholds are cumulative since the belt anchor, exactly as for adults: degree *n* at `n × 10` attendances; the belt at `maxStripes × 10 + 10`. For solid grey that is degree 11 at 110 and grey-black at 120.

Adult catalog is unchanged from Phase 2: white, blue, purple, brown, black.

Age hints are **advisory only**. If `dateOfBirth` is set and the student's age falls outside the rank's hint range, show a subtle badge on the profile. Never block a save, never auto-change a rank — coach criteria wins. **Kids → adult transition.** The kids track ends at `green_black`; from there a student moves to the **adult blue belt**, not white. Sixteen is the age at which a kid moves to the adult track — surface a "Transición a adulto" action then, running the explicit track-change flow above with adult blue as the default destination rank. The director can still choose otherwise; the default just shouldn't be wrong.

### Belt rendering — degrees counted vs. tapes shown

A kids belt can hold **11 degrees**, but the physical bar only ever shows **4 tapes**. New tapes replace older ones: degree 5 (the first red) takes the place of a white tape, so the belt still shows 4 tapes while the counter reads 5.

Two separate concepts:

- **degree count** (`currentStripes` / the existing degree field) — 0..`maxStripes`, drives promotion logic, progress bars and "grado 7 de 11" text;
- **drawn tapes** — at most `visibleStripeSlots` (4), derived from the counter, never stored.

#### Shared derivation

**Extend the existing `BeltGraphic` and `BeltBar` components around one shared visible-tapes derivation function.** Preserve existing display sizes through wrappers if needed. Do not maintain separate tape-counting implementations.

```ts
// src/lib/belt-display.ts
export function visibleTapes(rank: BeltRank, degrees: number): string[] {
  if (!Number.isInteger(degrees) || degrees <= 0) return []
  const slots = Number.isInteger(rank.visibleStripeSlots) && rank.visibleStripeSlots > 0
    ? rank.visibleStripeSlots
    : 4
  const earned = rank.stripeColors.slice(0, Math.min(degrees, rank.maxStripes))
  return earned.slice(-slots)   // rolling window: keep the newest N
}
```

Validate `degrees` and `visibleStripeSlots` **before** calling slice. Negative or non-integer degrees must not produce unexpected tapes.

Render left → right, oldest visible tape first, so a new award visually pushes the row along.

Worked examples, kids **Grey** (`maxStripes: 11`, tapes `[W,W,W,W,R,R,R,R,G,G,G]`, 4 slots):

| Degrees | Tapes drawn | Reads as |
|---|---|---|
| 3 | W W W | 3 white |
| 4 | W W W W | bar full |
| 5 | W W W **R** | one white replaced by red, counter says 5 |
| 6 | W W R R | |
| 8 | R R R R | all four red |
| 9 | R R R **G** | grey tape starts replacing red |
| 11 | R G G G | last degree before the next belt |

The same function handles the 5-degree ranks: degrees 1–4 white, degree 5 replaces the first white with red — matching the real belt, where the 5th is a red tape wrapped over a white one.

#### Visual design — a real belt, not two rectangles

The current graphic is a colored rectangle butted against a black rectangle. It reads as a progress bar, not a belt. Replace the **visual** with a realistic woven belt. The derivation above is unchanged — this is a rendering change only.

Build it as **one inline SVG component**. No raster images, no external assets, no canvas: it must scale, theme, print and work offline, and it appears in every list row.

Anatomy, back to front:

1. **Belt body** — a long horizontal strip, aspect ratio about **8:1**, with a small corner radius (fabric, not a pill). Ends are squared.
2. **Weave texture** — an SVG `<pattern>` of fine vertical lines at very low opacity (≈4–6%) over the body, giving woven cotton rather than flat fill. Slightly darker at the top and bottom edges.
3. **Longitudinal stitching** — **this is the single strongest realism cue**. Three to five evenly spaced dashed lines running the length of the belt, in a darker shade of the belt color (not black, not a fixed gray — derive it from the belt color so it works on white and on black belts). Dash pattern short and even, like machine stitching.
4. **Rank bar (barra)** — the black bar, set in **from the tip so a short tail of belt color remains beyond it** (roughly 8–10% of the length). A bar flush to the end is exactly what makes the current version look like a chart. The bar gets its own stitch line along each edge where it is sewn on. Its color comes from `BeltRank.barColor` — **never hardcode black**: a black belt's bar is red, and coral belts differ again.
5. **Tapes (franjas)** — rectangles across the bar, evenly spaced within `visibleStripeSlots` positions, each with a 1px darker edge and a subtle inner shadow at the wrap so they sit *on* the bar rather than inside it. Colors come from `visibleTapes()`.
6. **Depth** — a soft inner shadow along the belt's top and bottom edges, and a small drop shadow beneath the whole belt. Subtle: this is a list row, not a hero illustration.

**Split belts are a CENTRE STRIPE, not two halves.** A grey-white belt is a grey belt with a white band running lengthwise through the middle — roughly the middle third of the belt's height — not a belt that is 50% grey and 50% white. Same for every `_white` and `_black` rank: the belt keeps its own colour, and a contrasting band runs down the centre. The stitching rows sit above and below the band rather than crossing it.

Model this as `centerStripeColor` (nullable) on the rank, not as `isSplit` + `splitColor` — the naming should say what it draws.

#### Rendering rules

- **Size variants with graceful degradation.** `xs` (list rows), `sm` (cards), `lg` (student profile). At `xs`, drop the weave pattern and reduce stitching to two lines — sub-pixel detail turns into mud and costs render time. Detail is added going up, never removed going down.
- **Unique ids per instance.** Gradients, patterns and filters need ids; fifty list rows sharing hardcoded ids is a real bug that makes every belt inherit the first row's fill. Use React's `useId()` (or a single shared `<defs>` sprite rendered once), and test a page with at least 20 belts of different colors.
- **Deterministic.** No randomized tape rotation, no jitter, no animation on first paint. Screenshots must be stable for tests. A short transition when a tape changes after an award is fine.
- **Self-contained on any surface.** The belt paints its own background and edges, so a white belt on a white card and a black belt on a dark sidebar both stay visible. Give the body a thin border derived from its own color rather than relying on the page.
- **Performance.** Keep `xs` under ~20 SVG nodes. It renders once per student row.
- Unfilled tape positions are simply empty bar, never placeholder outlines.
- No compact/overflow variant is needed — the bar is fixed at `visibleStripeSlots`. Show the numeric degree beside it where space allows (`7/11`) and always in the tooltip.
- Accessible: `role="img"` with `aria-label` like "Cinturón gris, grado 7 de 11".

#### Label column

The current student list truncates the belt label ("Azul · sin fra…"). Fix it in the same pass: give the belt cell enough width for the graphic plus a non-truncating label, or drop the text to a second line under the belt at narrow widths. A rank the director can't read is worse than no label.

#### Verification

**This phase needs component-test tooling that the repo does not have.** Phase 2 closed one acceptance criterion by code reading because there is no way to assert against rendered output. Phase 3's criteria are far more visual than that, and several of them — no more than `visibleStripeSlots` tapes drawn for any rank or degree, split belts rendering as lengthwise halves, unique SVG ids across many instances, the label not truncating — are *structural facts about the DOM*, not aesthetic judgements. Those should be machine-checked.

Add `@testing-library/react` to the existing vitest setup before starting this phase, and split verification accordingly:

- **Machine-checked:** tape counts per rank and degree, split-belt band structure, distinct ids across 20+ rendered belts, the `aria-label` text, the degree number appearing beside the graphic, the reason text appearing on an ineligible card (retroactively closing Phase 2's open criterion).
- **Human-checked:** whether it actually looks like a belt. No test can answer that.

Build a dev-only page at `/dev/belts` rendering **every rank in both tracks at all three sizes, with every degree from 0 to `maxStripes`**, on light and dark surfaces. It is the fastest way to catch id collisions, invisible white tape, split-belt errors and the black-belt red bar. Screenshot it and look at it before calling the phase done — a validator cannot tell you the belt looks wrong.

#### Do not

- Do not store the drawn tapes. They are always derived.
- Do not cap the degree counter at 4, and do not reset it when tapes get replaced.
- Do not let promotion logic read the drawn tapes. The engine sees degrees only.

### Acceptance criteria

- [ ] Add/edit student requires a track and shows only that track's ranks for the student's organization.
- [ ] Seeding `alliance-cr` produces 13 kids ranks with the exact `maxStripes` and tape colors above, `visibleStripeSlots: 4`, 10 attendances per degree and 10 extra for the belt.
- [ ] A kids white belt with 47 promotion-relevant attendances since the belt anchor, and four explicitly awarded degrees, shows degree 4 and 7/10 progress toward degree 5. **Attendance alone does not grant degrees.**
- [ ] A kids grey belt at degree 11 shows `nextTarget = BELT` and needs cumulative 120 attendances since the belt anchor.
- [ ] `visibleTapes()` unit tests match the worked-examples table exactly, plus: degree 0, negative degrees, non-integer degrees, degrees above `maxStripes`, and a malformed `visibleStripeSlots`.
- [ ] No component draws more than `visibleStripeSlots` tapes for any rank or degree, while the UI still displays the true degree count.
- [ ] `/dev/belts` renders every rank in both tracks, every degree 0..`maxStripes`, at all three sizes, on light and dark surfaces — reviewed by screenshot, not assumed.
- [ ] A page with 20+ belts of different colors renders each with its own fill — no SVG id collision.
- [ ] The rank bar is set in from the tip with a visible tail of belt color, and its color comes from `barColor` (a black belt renders a red bar, not a black one).
- [ ] A white belt is fully visible on a white card and a black belt on a dark surface.
- [ ] `_white`/`_black` kids belts render a centre stripe through the middle third of the belt's height, not two colored halves and not two end-to-end blocks.
- [ ] The belt label in the student list is not truncated at any supported width.
- [ ] Awarding degree 5 on a kids grey belt changes the drawn tapes from 4 white to 3 white + 1 red and increments the counter to 5 — the bar does not grow.
- [ ] Existing adult students are untouched: same track, rank, degrees and anchors as the Phase 0 baseline.
- [ ] Creating a student with an initial credit writes exactly one `onboarding_credit` adjustment; the credit counts toward that student's promotion progress.
- [ ] The same credit does **not** appear in the weekly attendance trend or the attendance-by-class chart, and the two reconcile with each other after a credited student is added.
- [ ] The credit is visible in the student's attendance history as "crédito inicial" and is editable by a DIRECTOR, with the correction audited.
- [ ] The credit field defaults to 0 and a student created without touching it has no adjustment row at all.

---

## Phase 4 — Per-organization branding

### Data model

`OrganizationBranding`, one row per Organization:

- `displayName`;
- logo (mime type, bytes, updatedAt);
- `primaryColor` (default Alliance yellow `#FACC15`), `accentColor`, `surfaceStyle`;
- **sidebar palette** — `sidebarBackground` (default `#111827`), `sidebarForeground`, `sidebarActiveBackground`, `sidebarActiveForeground`, `sidebarBorder`.

Branches inherit their organization's branding. A per-branch logo is out of scope for v1.

**Logo storage:** the production provider is not chosen yet, so keep the decision reversible. Store the image in Postgres behind a **storage adapter interface** (`DbLogoStorage` as the default implementation), so that if the eventual host offers object storage, swapping to it is a new adapter rather than a migration of the feature. Constraints: PNG/JPEG/WebP/SVG only, ≤ 512 KB, max 1024×1024, validated and re-encoded server-side; SVG sanitized or rejected. Serve from a cached route with `Cache-Control: public, max-age=300, stale-while-revalidate` and an ETag derived from `logoUpdatedAt`. Fallback: organization initials on the primary color.

### Theming

Tailwind v4 + shadcn already uses CSS custom properties. Do **not** generate per-organization Tailwind builds.

- In the authenticated root layout (server component), load branding from the tenant context and emit overrides for the theme tokens: `--primary`, `--primary-foreground`, `--accent`, `--ring`, `--sidebar`, `--sidebar-foreground`, plus existing custom tokens.
- Derive foreground/hover/muted variants programmatically (convert to OKLCH, adjust lightness) in `src/lib/theme.ts`, with unit tests.
- **Contrast guard:** the settings color picker computes WCAG contrast against the surface and warns when the chosen primary would be unreadable, offering an auto-corrected suggestion.
- Ship 6 presets (Alliance yellow/dark among them) so a non-technical director can pick rather than fiddle with hex.

#### Sidebar palette — a full set of colors, chosen independently

The sidebar is not limited to black, white or the brand accent. A director picks its color freely, independently of `primaryColor`: a yellow-accent academy may run a navy sidebar, and a red-accent academy a near-black one.

- **Ship a palette of at least 12 sidebar presets**, each a complete, pre-validated set of the five sidebar tokens — not just a background color. Suggested range, dark through light: near-black, slate, navy, blue, teal, forest, olive, burgundy, brown, deep purple, warm gray, and a light/white sidebar.
- **Custom color** is also available. When a director picks a custom background, derive `sidebarForeground`, `sidebarActiveBackground`, `sidebarActiveForeground` and `sidebarBorder` from it through the same OKLCH helpers in `src/lib/theme.ts` — light backgrounds get dark text and a visible border, dark backgrounds get light text and no border. Each derived token stays individually overridable for a director who wants exact control.
- **Contrast is enforced here, not merely warned.** The sidebar is the app's primary navigation: nav label against sidebar background must meet **WCAG AA (4.5:1)**, and the active-item pair must meet it too. If a chosen combination fails, show the failure plainly and offer a one-click corrected version. Do not ship a palette that renders navigation unreadable, and do not let a preset ship failing its own check — validate the 12 presets in a unit test, both states.
- The logo sits on the sidebar, so the logo preview in settings and in the onboarding wizard must render **against the chosen sidebar color**, not against white. A director picking a dark sidebar with a dark logo needs to see that immediately.
- Live preview shows a real sidebar with nav items in default, hover and active states — not a color swatch.

### Settings UI

Build the logo uploader and the theme picker as **standalone reusable components**, not page-local markup — Phase 5's onboarding wizard renders the same two controls, and duplicating them there is a bug.

New page **Configuración → Academia** (org ADMIN/DIRECTOR only):

1. Organization name, display name, slug (slug editable by SUPER_ADMIN only once active).
2. Logo upload with live preview (sidebar + kiosk).
3. Theme presets + custom pickers with a live preview panel.
4. Default locale and timezone.
5. Promotion rules from Phase 2: mode per track, coach-approval toggle, editable rank table, and the branch-override surface if overrides exist.

### Acceptance criteria

- [ ] No literal "Alliance", brand hex or logo path remains in `src/**`.
- [ ] A second seeded organization with a blue theme and its own logo renders blue sidebar/buttons/kiosk with its own logo; Alliance still renders yellow.
- [ ] Kiosk, login page and student portal all show the organization's branding, resolved from the branch's organization.
- [ ] A 3 MB file or an `.exe` renamed to `.png` is rejected with a clear localized error.
- [ ] Contrast guard warns on unreadable choices.
- [ ] `src/lib/theme.ts` has tests for derived variants and contrast math.
- [ ] At least 12 sidebar presets exist, each a complete five-token set; a unit test asserts every preset passes WCAG AA for both the normal and the active nav pair.
- [ ] A custom sidebar color derives readable foreground, active and border tokens automatically, and each remains individually overridable.
- [ ] A failing custom combination is blocked from saving with a one-click corrected alternative offered — not merely warned.
- [ ] Sidebar color is independent of `primaryColor`: a yellow-accent organization with a navy sidebar renders correctly in both places.
- [ ] The logo preview renders against the selected sidebar color in both the settings page and the onboarding wizard.

---

## Phase 5 — Public organization registration + approval and invitations

### Public page

Unauthenticated route `/[locale]/registro-academia` (en: `/register-academy`), linked from the login page footer. The public UI may call this "your academy"; the record created is an Organization.

Fields: organization name, country, city, contact name, contact email, contact phone, student-count band, referral source, preferred locale, terms acceptance.  Desired slug auto-suggested from the name with a live availability check.

**Persist all submitted registration fields**, including student-count band, referral source, terms version, and `acceptedAt`.

On submit:

- Create the pending organization and its configuration **atomically**: `Organization` (status `PENDING`), branding defaults, `PromotionConfig`, and both seeded rank catalogs in one transaction.
- Do not create a usable login yet, and do not send credentials.
- Send email **after** the transaction; email failure does not roll back signup.
- Rate-limit by IP and email (DB-backed counter is fine). Honeypot field. Duplicate emails/slugs handled gracefully, no 500.
- Success screen explains the request is under review.

### Invitations and approval

Reuse or extend the **existing password-reset token infrastructure** for invitations. Tokens must be hashed, expiring, single-use, and invalidated appropriately on resend.

If the director email already belongs to a `User`, invite that identity to the organization **without overwriting its password or existing memberships** — this is exactly the multi-organization membership case from Phase 1.

On approve:

1. `status → ACTIVE`, `approvedAt`, `approvedById`.
2. Create or reuse the director identity and grant organization membership with the DIRECTOR role.
3. Create a default branch (`Academy`) named after the city so the organization can start adding classes.
4. Issue the invitation token; if email is not configured, the admin panel shows the link for manual sending.

**Approval must be idempotent:** retries must not create duplicate branches, memberships, or invitations.

On reject: `status → CANCELLED` with an internal reason note. Never hard-delete.

Users of a `PENDING`, `SUSPENDED` or `CANCELLED` organization cannot sign in and see a clear localized message, not a generic auth error.

### First-login onboarding wizard

Branding is **not** collected on the public form. The public registration endpoint is unauthenticated, so accepting file uploads there would mean storing arbitrary bytes from anyone who fills in the form, before any approval — and a rejected request would leave an orphaned image. Instead the director sets up branding on first login, when they are authenticated and the organization is real.

Add `Organization.onboardingCompletedAt DateTime?`.

**Trigger:** after the director accepts the invitation and sets their password, if `onboardingCompletedAt` is null and the user holds an ADMIN/DIRECTOR membership for that organization, route them to `/[locale]/onboarding` instead of the dashboard. Any other role — INSTRUCTOR, STUDENT — never sees the wizard and is never redirected. The kiosk is never affected.

**Steps** (3, with a visible progress indicator):

1. **Academy name** — confirm or edit `name` and `displayName`; slug shown read-only with a note that support can change it.
2. **Logo** — upload with live preview in the sidebar and kiosk mock. Skippable; the initials-on-primary-color fallback is shown as the alternative so skipping looks like a choice, not a gap.
3. **Theme** — the 6 presets plus custom pickers, with the same live preview panel and contrast guard as the settings page.

**Rules:**

- **Reuse the Phase 4 components as-is.** The wizard is a guided wrapper around the existing settings controls — same upload validation (PNG/JPEG/WebP/SVG, ≤ 512 KB, max 1024×1024, server-side validation, SVG sanitized or rejected), same theme derivation, same contrast guard. Do not write a second logo uploader or color picker; if a control needs to work in both places, lift it into a shared component rather than copying it.
- **Each step saves as it completes**, so closing the browser mid-wizard keeps the logo that was already uploaded. Re-entering resumes at the first incomplete step.
- **Fully skippable.** A "Lo haré después / I'll do this later" action sets `onboardingCompletedAt` and lands on the dashboard with defaults intact. A dismissible card on the dashboard then links to Configuración → Academia. Never trap the director in the wizard, and never block them from the app over branding.
- **Idempotent and non-reentrant.** Once `onboardingCompletedAt` is set, `/onboarding` redirects to the settings page. Nothing is lost or reset by visiting it again.
- Completion and each branding change are audited per Phase 6.
- Both locales, like everything else.

### Acceptance criteria

- [x] Submitting the public form creates a PENDING organization with seeded ranks, branding and config in one transaction, and no active login.
- [x] All submitted fields, including terms version and `acceptedAt`, are persisted.
- [x] A simulated email failure leaves the signup committed (`tests/integration/organization-registration.test.ts`).
- [x] Slug collisions, duplicate contact emails, and a filled honeypot are handled without a 500.
- [x] Rate limit blocks repeated submissions from the same IP within the window.
- [x] Approving twice produces exactly one branch, one membership and one valid invitation.
- [x] An existing user invited as director keeps their password and prior memberships and can switch organizations (pre-existing `/select-organization` multi-membership flow, untouched).
- [x] Invitation tokens are hashed, single-use, and expire; resend invalidates the prior token.
- [x] Users of non-ACTIVE organizations get the explicit localized message (pre-existing `/organization-unavailable` + `requireTenantContext`'s `ORG_NOT_ACTIVE` handling, untouched — this phase adds no new behavior here, it only adds a *pre-auth* neutral fallback at `/o/[orgSlug]/login` for the same fact).
- [x] The public form accepts no file upload and no color input — a request that posts a `logo`/`primaryColor` field alongside a real submission is genuinely REJECTED (`error: "invalid"`), enforced by `z.strictObject` (not Zod's default key-stripping, which was the original, weaker basis for this checkbox — see the Implementation record below for why that was corrected). Asserted directly by a test that posts a crafted request with both fields present (`tests/integration/organization-registration.test.ts`).
- [x] A director completing invitation setup lands on `/onboarding`; an instructor or student of the same organization never does and is never redirected there.
- [x] Uploading a logo in step 2, closing the browser, and signing in again resumes at the same step with the logo still set — verified live through a real browser (navigated away mid-step-2, confirmed resumption at step 2 exactly, the same persistence mechanism the doc's step-3 example describes).
- [x] Skipping sets `onboardingCompletedAt` and lands on the dashboard with default branding intact.
- [x] The dismissible reminder card on the dashboard linking to Configuración → Academia — shown to ADMIN/DIRECTOR while the organization has no logo uploaded and hasn't dismissed it before; dismissal persists on `Organization.brandingReminderDismissedAt`, per organization, not a per-browser flag (see Item 2's Implementation record entry below — this was flagged as NOT implemented after Phase 5's initial merge, then built as part of Item 2).
- [x] Revisiting `/onboarding` after completion redirects to Configuración → Academia and changes nothing.
- [x] The wizard and the settings page share one logo-upload component and one theme picker — literally the same `LogoUploader`/`ThemePicker` imports and the same `admin/branding/actions.ts` save actions, not a second implementation.

### Implementation record

**Per-organization routing: path segment (`/o/[orgSlug]/...`), never a subdomain.** A subdomain needs wildcard DNS and a wildcard cert, which means committing to a hosting provider before one is picked — the Global rules are explicit that "the production database provider is not chosen yet... nothing is in production." A path segment needs none of that and mirrors this codebase's own existing `/kiosk/[academySlug]` pattern exactly. Scope is deliberately narrow: only pre-auth, identity-establishing pages (`/o/[orgSlug]/login`, `/o/[orgSlug]/signup`) gained the segment. Every authenticated page keeps resolving organization identity from the verified session exactly as before — the slug is a pre-auth *display* signal, never an authorization input (stated explicitly as a comment at every point it's read, so the next person doesn't turn it into a scoping key). `resolveSingleOrganizationBranding` (Phase 4's stopgap) is deleted outright, as promised when it was built.

**Deviation from the doc's literal routing text**: the doc names `/[locale]/registro-academia` (es) / `/register-academy` (en) — a next-intl *localized pathname*. No route in this codebase uses that feature; every other route keeps the same English path segment regardless of locale. Followed that established convention instead (`/register-academy` for both locales) rather than introducing a new routing mechanism for one page.

**`/signup`'s hardcoded-to-Alliance stopgap is closed, not merely worked around.** Moved to `/o/[orgSlug]/signup`; `resolveOrganizationForSignup` scopes the academy list by the URL's own organization, verified server-side against the ORG the slug actually names (never trusting a hidden form field) — closing the exact gap the moment a second organization exists, as required. Bare `/signup` is deleted.

**`Invitation` is its own table, not an extension of `PasswordResetToken`.** Traced directly: `PasswordResetToken.userId` is required and non-nullable, meaning it fundamentally means "prove you own THIS EXISTING account's email" — a brand-new director invitation has no such account yet. Reuses the same hashing/expiry/single-use/resend-invalidates-prior-token *pattern* `forgot-password/actions.ts` established, never the table itself. Same reasoning that produced `PromotionCredit` as its own table rather than an overloaded column.

**`RegistrationAttempt` is its own table, not `AuditLog`.** Verified directly (not assumed): `AuditLog.actorId` is nullable (Phase 2c-iii), so the original premise for a separate table was wrong. The real reason survives the correction: `AuditLog.entityType`/`entityId` are non-nullable and must reference a real, already-existing entity — a rate-limited registration attempt, the common case this table exists for, creates nothing at all. A transient, high-volume counter also has a different purpose and retention shape than a permanent record of real actions against real entities.

**Email delivery is real, not a copy of `forgot-password`'s stub.** Traced the actual current state rather than assuming a token-link email pathway was already solved: `forgot-password/actions.ts`'s reset-link email is still a `console.log` stub, explicitly deferred to *REDESIGN_BRIEF.md's* Phase 8 (a different document's Phase 8 — see this doc's own "qualify phase numbers with the document name" rule). The staff-notification `EmailChannel`/Resend wiring, however, is real and already proven. Registration confirmation and invitation emails use that real pathway (`src/lib/email/send-transactional-email.ts`), not the stub — these are the first things a prospective customer sees from this product. A send failure is logged loudly and never rolls back or orphans the already-committed row, matching the doc's own "email failure does not roll back signup," generalized to approval.

**A real SUPER_ADMIN bootstrap account was added** (`superadmin@alliancecr.com`, seeded), satisfying Appendix C decision 5's "a platform-wide grant, explicitly bootstrapped" — none existed anywhere in this codebase before this phase. `scripts/approve-organization.ts --approved-by` requires this exact grant, not a regular org ADMIN, since approving an organization is a platform-level action.

**Two real bugs found while building and testing this phase, unrelated to each other:**
1. `next/headers()`'s `headers()` throws ("called outside a request scope") when called anywhere other than a genuine Next.js request — found directly by running `registerOrganization()` from a plain integration test. The same class of Next-runtime-only-API limitation Phase 4's `unstable_cache` discovery already established for this codebase. Fixed by having `resolveClientIp()` fall back to a shared `"unknown"` bucket on that failure — consistent with, not a weakening of, this signal's own already-documented best-effort nature (it was never a hard security boundary; `x-forwarded-for` can be forged/rotated by the caller regardless).
2. Test isolation: with `resolveClientIp()` falling back to `"unknown"` in every integration test (none run inside a real request), every test in `organization-registration.test.ts` shared the same IP-based rate-limit bucket and polluted each other's counts. Fixed with a `beforeEach` clearing `RegistrationAttempt` rows with `ip: "unknown"` — a value only these tests ever produce in this environment.

**Two corrections made after post-merge review, both to `resolveClientIp`/`isRegistrationRateLimited` and the schema in `register-academy/actions.ts`:**
1. **The `"unknown"` IP fallback was a fail-closed, shared-bucket risk.** Bug 1 above's fix (falling back to a shared `"unknown"` string) meant every caller with no resolvable IP counted against the SAME rate-limit bucket — on a host that doesn't set `x-forwarded-for`, or if `headers()` throws for any other reason, three registration attempts from any one such caller would lock out every OTHER legitimate registration on the entire platform, on the one form that brings in customers. Fixed by making the per-email limit the sole check when `ip === "unknown"` — the IP axis is skipped entirely rather than applied to a bucket every unresolvable caller shares. This fails open on the IP axis specifically, relying on the still-enforced per-email limit, which is the safer direction for a customer-acquisition-critical form: worse to under-limit a signal already documented as forgeable/best-effort than to shut out every legitimate applicant sharing an ambiguous bucket. Covered directly by a test proving 6 different emails (one past `REGISTRATION_MAX_PER_IP`) all succeed despite sharing `ip: "unknown"`, while each email's own limit still applies.
2. **The file/color-upload rejection checkbox was ticked on the wrong evidence.** It was originally checked off because Zod's plain `z.object()` silently strips unrecognized keys, and a crafted `logo`/`primaryColor` field was therefore never processed — described as "the same practical guarantee" as a real rejection. It is not: that guarantee holds only because of a library default, not because anything enforces it, the same "looked correct, checked nothing" shape this project has now found five times (`getScopedDb` zero callers, `requireTenantContext` unreachable via real login, the `$extends` backstop covering only the already-safe path, the contrast self-comparison tautology, and this one). Fixed by switching the schema to `z.strictObject`, which turns an unrecognized key into a genuine `safeParse` failure (`error: "invalid"`), and adding a test that posts a crafted request with both a `logo` file field and a `primaryColor` field and asserts the request is rejected — not merely that nothing was processed — and that no organization is created.

**Found, flagged, then reclassified and fixed as Item 2 (its own PR, not silently expanded into this one):** several staff-page "eyebrow" labels, `BrandBanner`'s zero-props fallback, and other hardcoded "Alliance" text were found here and deliberately not fixed in this phase's original PR — at the time described as "cosmetic-only (a wrong name/logo shown, never a data leak)." That framing was wrong and has been corrected: for a product being sold to competing academies, a new director's own dashboard reading "Alliance Costa Rica · Panel" is the software telling a paying customer they're using someone else's — a credibility problem, not a polish item, precisely because Phase 5 made a second, real, paying organization possible. See Item 2's own Implementation record entry below for the actual fix.

**Item 2 — a genuine sweep for every hardcoded "Alliance" string/asset, not just the four eyebrows originally flagged.** Grepping the whole repo case-insensitively surfaced 8 message keys across `messages/{en,es}.json` (not 4): `app.title`, `home.heading`, `dashboard.analytics.eyebrow`, `students.eyebrow`, `branding.eyebrow`, `payments.eyebrow` (a fifth eyebrow, previously unflagged), `adminSchedule.eyebrow`, and `staffShell.breadcrumbPrefix` (the exact "Alliance Costa Rica" half of the "Alliance Costa Rica · Panel" string quoted above). Also found: `LogoMark`'s `alt` text was hardcoded to the same string in EVERY branch, not just the zero-props fallback — meaning a real organization's own uploaded logo was announced to screen readers as "Alliance Jiu-Jitsu Costa Rica"; `/o/[orgSlug]/signup` rendered a zero-props `<BrandBanner />` despite already knowing the real organization (the same leak `/o/[orgSlug]/login` had already been built to avoid); `public/manifest.json` hardcoded the PWA install name; `EMAIL_FROM` (shared by every email this deployment sends) hardcoded "Alliance BJJ" as the sender identity for registration-confirmation and invitation emails to prospective customers of OTHER academies — and, on reflection, for every organization's own staff notifications too, since `EMAIL_FROM` is per-deployment, not per-organization; and `src/app/icon.png`/`favicon.ico`/`public/icon-192.png`/`icon-512.png` were Alliance's own branded artwork.

Fixed:
- One exported constant, `PLATFORM_NAME` (`src/lib/platform.ts`), is the platform's name wherever there's no organization to name — genuinely pre-tenant pages, the browser-tab `<title>`, and the PWA manifest. A real product name has not been chosen; changing `src/lib/platform.ts`'s one `PLATFORM_NAME` line is the entire update once it is.
- Authenticated pages now show the organization's own `displayName`, resolved via the existing `getOrganizationBranding`/`resolveOrganizationLoginBranding` reads every branded surface already had — genuinely "mostly plumbing," as anticipated: `LogoMark` gained an `alt` prop (falls back to `PLATFORM_NAME` only when no organization is known at all), the 5 eyebrow strings became `"{orgName} · X"` with each page passing its own resolved `displayName`, and `staffShell.breadcrumbPrefix` was deleted in favor of a `StaffTopBar` `orgName` prop.
- `/o/[orgSlug]/signup` now calls `resolveOrganizationLoginBranding` (the same function `/o/[orgSlug]/login` already used) and renders that organization's real logo/initials/name, not Alliance's.
- The marketing homepage (`/`) is rewritten as platform marketing, deliberately minimal and structural rather than invented enthusiasm — real marketing copy needs a real product name and positioning, neither of which exists yet. Its CTA now points at `/register-academy` (the platform's own registration entry point) instead of a hardcoded link to Alliance's own `/o/alliance-cr/signup`; Alliance reaches its own students through that URL directly, not through this page.
- `public/manifest.json` (a static asset, unable to import a shared TS constant) is replaced by `src/app/manifest.ts`, Next's own dynamic-manifest file convention, importing `PLATFORM_NAME` directly — one source of truth instead of a second copy that would silently drift on rename day. Confirmed served: `curl localhost:3000/manifest.webmanifest` returns the generated JSON, and the rendered `<head>` carries `<link rel="manifest" href="/manifest.webmanifest">`, injected automatically by the file convention.
- `EMAIL_FROM` is now the platform's own neutral sender identity (`"Platform Notifications <...>"`), used unchanged by every email path (staff notifications, registration confirmation, invitations) — never a single organization's name, since one deployment's sender identity can never correctly name more than one organization. An organization's own identity already lived in the subject/body where it can be genuinely per-tenant (`weeklyDigest.title`'s own `{academyName}` interpolation, unchanged) — audited every `EmailChannel`/`sendTransactionalEmail` caller (stripe/exam threshold, new-signup, weekly digest, registration confirmation, invitation) and found no other template hardcodes an organization name. Production needs a real verified Resend sending domain once the platform is named — noted, not solved here.
- `src/app/icon.png`, `src/app/favicon.ico`, `public/icon-192.png`, and `public/icon-512.png` were regenerated as neutral placeholders (a plain "P" monogram on the same `#111827`/`#ffffff` pair `LogoMark`'s own initials-avatar fallback already uses, via `sharp`) — an honest placeholder, not real brand identity, so no organization sees Alliance's own artwork on their installed PWA icon or browser tab. Real artwork replaces these once the product is named.
- The dashboard's dismissible "you skipped branding, finish it here" card, flagged as not built when Phase 5 originally merged, is now built (`branding-reminder-card.tsx`/`branding-reminder-actions.ts`, `Organization.brandingReminderDismissedAt`) — see the acceptance criteria above.

After this fix, a repo-wide case-insensitive grep for "alliance" was re-run: every remaining hit is Alliance's own real seed data (`prisma/seed.ts` and its fixtures), a doc, a test fixture, or a comment narrating history/reasoning — none are user-visible strings.

**Verified end-to-end through the real browser and the real CLI**, not only through mocked tests: registration (including the live slug-availability check, honeypot silent-success, and rate-limit trip after 3 attempts) → `scripts/approve-organization.ts` (including idempotent re-run) → invitation acceptance (real auto-sign-in via the same credentials provider `/login` uses) → the full 3-step onboarding wizard (including resumption after navigating away mid-wizard, and the idempotent post-completion redirect) → the new organization's own scoped `/o/[orgSlug]/signup` correctly listing only its own academy. `RESEND_API_KEY` is a dev placeholder in this environment — the real approval CLI run against it produced a genuine `401 API key is invalid` from Resend, which is exactly the failure-handling path this phase's design accounts for: the organization was still approved, the academy/membership/invitation were still created, and the invitation link was still printed to the operator's console for manual sharing.

---

## Phase 6 — Platform admin panel, audit, and authorization

**Deviation from the doc's literal routing text, decided during this phase's brainstorm and applied before any code was written:** the route group is `/[locale]/platform/**`, not `/[locale]/admin/**` as originally written here. `/admin/branding`, `/admin/kiosk-tokens`, and `/admin/schedule` (all shipped in earlier phases) already occupy that exact prefix, gated by the ORGANIZATION role `ADMIN` (`requireTenantContext(["ADMIN"])`) — a completely different authorization domain from the platform-wide `isSuperAdmin` flag this phase gates. Sharing a URL prefix between two unrelated authorization meanings is the exact ambiguity that produced every real tenant-isolation bug this project has found (revision 23, the layout leak, the unauthenticated-signup leak). `/platform/**` keeps the two domains structurally distinct everywhere, at zero cost to the three existing `/admin/*` pages. Restricted to `isSuperAdmin` via a server-side check (`requireSuperAdmin`/`resolveSuperAdminActionContext`) in the layout **and** in every server action — not middleware alone. This is the only place the platform/global data-access module (`platform-lookups.ts`) is used outside the paths listed in Phase 1.

### Pages

**`/platform/organizations`** — list: logo, name, slug, status, country/city, branch count, student count, active students, attendance in the last 30 days, created/approved dates, last activity. Filters by status and country; search by name/slug/contact. Row actions: view, suspend, reactivate. Approve/reject live on the pending queue page instead (below). "Open as" (impersonation) is deliberately not offered — see the Phase 6 open question below.

**`/platform/organizations/pending`** — approval queue with the full submitted form and Approve / Reject with a note, reachable from a badge counter in the admin sidebar.

**`/platform/organizations/new`** — manual registration: same fields as the public form, plus direct ACTIVE status, director email, optional branding, and a promotion preset (attendance / time-based / manual). Creates organization, branding, config, rank catalogs, first branch and the director invitation in one transaction, reusing the same idempotent approval path.

**`/platform/organizations/[id]`** — detail: overview and internal notes, branding, promotion rules, branches, members, audit trail, danger zone (suspend, cancel — never hard delete).

**`/platform`** — overview: organizations by status, total students across organizations, new organizations this month, attendance trend (recharts, same visual language as the director dashboard), pending-requests callout.

**`/platform/admins`** — not originally named as its own page in this doc, added during the brainstorm: `isSuperAdmin` had exactly one seeded holder and no UI at all before this phase. Lists every current holder; an existing platform admin can grant it to another user by email or revoke it. Self-revocation is disallowed outright (decided during the brainstorm: `requireSuperAdmin()` re-reads fresh on every request, so a self-revoke would lock the actor out of the very page they're using to manage this, mid-session, with no benefit over asking another platform admin). Revoking the last remaining platform admin is refused unconditionally, as defense-in-depth against a lockout with no recovery path short of a raw database write — currently unreachable through this action alone, since the self-revoke check already covers the only path the action's own auth model can produce, but kept for the invariant itself in case that model ever changes.

### Open question: impersonation is not delivered in this phase

The doc's original page list named an "open as" row action (impersonation) as part of the organizations list, and `AccessContext`'s own type (`tenant/types.ts`) already reserves a shape for it (`impersonation?: { asSuperAdminUserId, startedAt, readOnly }`). Deliberately deferred, not built: a platform admin acting inside a paying customer's account is the most sensitive capability in this system, and it deserves its own design pass — what gets audited and how it's distinguished from the real user's own actions, a banner the impersonated organization cannot miss, a time limit, and a decision about whether this capability is wanted at all before a single paying customer exists to justify it. Building it as a rushed extension of this phase's own row-action list would be exactly the kind of scope-creep this project's own process exists to prevent. Flagged here as a real, open question — not a silent omission.

### Known future need: a director-facing audit view

`resolveOrganizationAuditTrail` (platform-lookups.ts) only serves the platform admin's own `/platform/organizations/[id]` page. No director-facing "who changed this?" view exists anywhere in this phase, and the doc never specified one. It's a real future need, not a gap invented here: promotion corrections were built with an audit trail partly to answer exactly "who changed this student's belt?", and a director will ask that question eventually with no page to answer it. Recorded here rather than silently left out — building it now would mean inventing its own scope, its own organizationId-filtered query, and its own acceptance criteria with no source of truth to check them against.

### Organization billing status and grace period

**This is platform billing — the organization paying Alexis for the app. It is a different concept from the existing Pagos section, which tracks students paying their academy. Do not merge the two models, pages, or terminology.** Nothing here processes money; it records state that Alexis sets manually, exactly like the student payment flow.

#### Data model

Add to `Organization`:

- `graceDays Int @default(5)` — the platform default applied to **newly issued** invoices for this organization;
- `billingNote String?` — internal.

Add `OrganizationInvoice` (a distinct model — do not reuse `PaymentPlan` / `PaymentPeriod`, which are student-facing):

- `organizationId`;
- `periodStart`, `periodEnd`;
- `dueOn` — a **calendar date**, not an instant;
- `graceDaysApplied Int` — **snapshot of `Organization.graceDays` at issue time**;
- `graceExtensionDays Int @default(0)` — explicit per-invoice extension;
- `paidAt DateTime?`, `paidNote String?`, `recordedByUserId String?`;
- `voidedAt DateTime?`, `voidReason String?`;
- `createdAt`, `updatedAt`.

#### Invoice creation (v1)

**Platform invoices are created manually by `SUPER_ADMIN` in v1.** Creation snapshots the organization's `graceDays` into `graceDaysApplied`. **No scheduled job creates invoices.** Deadline evaluation still updates billing visibility automatically as time passes, without marking invoices paid or suspending organizations.

This deliberately avoids recurrence, proration and duplicate-job handling until they are actually needed. Do not add a billing cron, a "next invoice" scheduler, or a recurring-plan model in this phase.

The create form lives in the admin panel on the organization detail page: period start/end, due date, and an optional note. It shows the `graceDays` value being snapshotted and the resulting deadline before saving, so the number is never a surprise after the fact. Creation is audited.

#### Deadline calculation (exact)

All of it derived, never stored:

```
effectiveGraceDays = graceDaysApplied + graceExtensionDays
graceEndsOn        = dueOn.plus({ days: effectiveGraceDays })        // Luxon calendar days
flaggedFrom        = graceEndsOn.plus({ days: 1 }).startOf('day')    // in Organization.timezone
```

- The due date and both derived dates are **calendar dates resolved in the organization's timezone**, never in UTC and never in the server's local zone. Compare against `DateTime.now().setZone(org.timezone)`.
- The grace window is **inclusive** of `graceEndsOn`: an invoice due Jan 28 with 5 grace days is inside grace through **Feb 2**, and becomes flagged at `00:00` org-time on **Feb 3**.
- Use Luxon calendar-day addition. Never add `n * 86400000` milliseconds, and never approximate.
- `graceDays` and `graceExtensionDays` must be non-negative integers. `0` is valid and means the deadline is the due date itself.

| State | Condition | Effect |
|---|---|---|
| `CURRENT` | no open invoice, or `paidAt` set | nothing |
| `DUE` | `now > endOf(dueOn)` and `now < flaggedFrom` | organization stays **ACTIVE**, app fully functional, kiosk normal |
| `GRACE_EXPIRED` | `now >= flaggedFrom`, unpaid | **flagged for review** in the admin queue; still ACTIVE |

`now` is always `DateTime.now().setZone(org.timezone)`. The `>=` on `flaggedFrom` is deliberate — see the precision rules below.

#### Who may change grace, and what it affects

- `Organization.graceDays` is editable by **`SUPER_ADMIN` only**, and `graceExtensionDays` on a specific invoice likewise, with a required note.
- **"Not visible to directors" means omitted from the data, not hidden in the UI.** `graceDays`, `graceDaysApplied`, `graceExtensionDays` and the review fields must be absent from every director-facing payload: route-handler JSON, server-action return values, and server-component props — RSC props are serialized into the page payload and are readable by anyone who opens devtools. Select explicit field lists for organization reads on director surfaces; never `include: { organization: true }` or a bare `findUnique` whose whole row is handed to a component. Route these through a director-facing DTO/serializer and assert the omission in tests against the actual serialized payload, not against the rendered DOM.
- A director sees only the invoice's due date and its current deadline date. The grace number itself is never sent.
- **Changing `Organization.graceDays` affects only invoices issued after the change. Outstanding invoices keep the `graceDaysApplied` they were issued with.** This is why the value is snapshotted: a deadline a customer has already been told must never move silently, in either direction — and shortening the default retroactively could flag several accounts overnight.
- To move an outstanding invoice's deadline, use the explicit per-invoice extension. If the extension pushes `flaggedFrom` into the future, the invoice returns from `GRACE_EXPIRED` to `DUE` and the review flag clears; that transition is audited like any other.
- Both changes write `AuditLog` rows with before/after values, the actor, and the note: `organization.graceDays.changed` and `organizationInvoice.graceExtended`.
- The settings UI states the rule in plain language next to the field: *"Applies to invoices issued from now on. Outstanding invoices keep their current deadline — extend those individually."*

#### Manual enforcement

- **Billing state never changes `Organization.status`.** No job, action or cron may set `SUSPENDED` from billing state. Exceeding grace **flags the account for review**; a human decides what happens next.
- The review flag is workable state, not just a badge: `reviewAcknowledgedAt`, `reviewAcknowledgedById` and `reviewNote` on the invoice let Alexis record "spoke to the director, transfer coming Friday" and take it out of the unreviewed queue without paying or suspending anything.

**Acknowledgment is not resolution.** An acknowledged invoice is still `GRACE_EXPIRED` and still unpaid. It leaves the *unreviewed* queue only. It stays in the outstanding-invoices view, still counts as overdue everywhere overdue is reported, and the director's escalated banner does not change. Only `paidAt` (or voiding) resolves an invoice. Never let acknowledgment flip a derived state, clear the banner, or remove the invoice from outstanding totals.

**Acknowledgment is scoped to one expiration episode.** Store `reviewAcknowledgedForFlaggedOn` (a date) alongside the acknowledgment fields, set to the `flaggedFrom` date that was current when it was acknowledged. The invoice is *unreviewed* whenever:

```ts
const now = DateTime.now().setZone(org.timezone)

const isExpired   = now >= flaggedFrom                       // inclusive: expiration starts exactly at midnight
const ackKey      = invoice.reviewAcknowledgedForFlaggedOn   // stored as a date
const isUnreviewed = isExpired && toKey(ackKey) !== toKey(flaggedFrom)
```

Two precision rules:

- Use `now >= flaggedFrom`, **not** "`flaggedFrom` is in the past". `flaggedFrom` is already `startOf('day')`, so `>=` makes expiration begin exactly at `00:00:00.000` org-time. A strict `>` would leave the first millisecond of the day unexpired.
- Compare acknowledgment keys by their **canonical date value**, never by object identity. `dateA !== dateB` on two JavaScript `Date` objects is reference comparison and is always true even for the same instant — the classic version of this bug silently makes every acknowledgment look stale (or, with a sloppy fix, never stale). Normalize both sides through one helper before comparing, e.g. `toKey = (d) => DateTime.fromJSDate(d).setZone(org.timezone).toISODate()`, and compare the resulting `YYYY-MM-DD` strings. The same applies anywhere else two dates are compared for equality in billing code.

So if an extension pushes the deadline out and the invoice later expires again, `flaggedFrom` is a new date, the stale acknowledgment no longer matches, and a **fresh review item appears** — an old `reviewAcknowledgedAt` can never suppress it indefinitely. Each acknowledgment writes its own `AuditLog` row, so the sequence of episodes stays auditable without a second model.
- During `DUE`, show a non-blocking banner to that organization's ADMIN/DIRECTOR only — never to instructors, students, or the kiosk. It names the due date and the deadline, fully localized, and never exposes `graceDays` as a number the director can act on.
- During `GRACE_EXPIRED` the banner escalates in tone but still blocks nothing.
- Recording payment sets `paidAt` and clears the banner and flag immediately, audited with before/after values.
- The admin list gains a billing column and filters for `DUE` / `GRACE_EXPIRED` / acknowledged, so the overdue set is one click away.

### Authorization and status enforcement

Enforce organization status on protected requests and mutations, **including existing sessions** — a director whose organization is suspended mid-session loses access on their next request, not at their next login.

Enforce impersonation permissions, read-only mode, and expiration **on the server**. A banner or a disabled button is not an authorization control. Impersonation writes an audit row at start and stop, is read-only unless edits are explicitly enabled (logged again), and expires after 60 minutes. **Deferred — see the Phase 6 open question above.** Not built in this PR; the criteria below that depend on it are marked accordingly.

### Audit

**Extend the existing `AuditLog`; do not introduce a duplicate model.** Write entries for: organization approve/reject/suspend/reactivate, impersonation start/stop, manual promotions and corrections, promotion-rule and configuration changes with before/after values, membership changes, and branding changes. Surface the trail on the organization detail page. **`AuditLog` itself moved into `TENANT_SCOPED_MODELS` as part of this phase — see the Implementation record below.**

### Acceptance criteria — organizations, approval, audit, authorization (this PR)

- [x] An org ADMIN hitting any `/platform` route or server action gets **exactly 404**, never 403 and never 200 — verified by test for both the page (real HTTP, smoke suite) and the actions (`resolveSuperAdminActionContext`). 404, not a `{403, 404}` range: a 403 would itself disclose that the route exists, which "disclose to members, never to non-members" forbids when the caller is a non-member of the platform surface.
- [x] Counts on the list match direct queries for a seeded fixture of organizations (`listOrganizationsForPlatformAdmin`'s `groupBy` aggregates, asserted against direct Prisma counts).
- [x] Manual creation produces a fully working organization (ranks seeded, director invited, first branch created) with no manual SQL, and reuses the same idempotent `approveOrganization()` path as self-serve registration.
- [x] Suspending an organization blocks its users on their next request with an existing session open, without deleting data; reactivating restores access — verified by a test that suspends via the panel's own action (not a direct DB write) with a director's session already open, and asserts their very next `getTenantContext()` call is refused.
- [ ] Impersonation is server-enforced: read-only by default, expires, and both start and stop are audited. **Deferred — not built in this PR (see open question above).**
- [x] Every platform-admin mutation writes an `AuditLog` row with before/after values where applicable.
- [x] `AuditLog` reads are tenant-guarded like every other model: a query missing `organizationId` throws, and the one deliberately cross-tenant reader (`resolveOrganizationAuditTrail`) is a single named function, verified by an isolation test asserting one organization's audit rows never appear in another's trail.
- [x] The panel's approve action and `scripts/approve-organization.ts` produce identical results (organization status, branch, invitation, and audit row) from identical starting states — both call the same `approveOrganization()`, verified directly, not merely by code inspection.
- [x] A platform admin cannot revoke their own access, even mid-session; revoking the last remaining platform admin is refused (defense-in-depth; see the `/platform/admins` page description above for why the second case is currently unreachable through this action alone).

### Acceptance criteria — billing

- [x] An organization one day past `dueOn` is `DUE`, remains ACTIVE, and its kiosk and every page work normally; only its ADMIN/DIRECTOR see the banner.
- [x] An invoice due Jan 28 with 5 grace days is `DUE` through Feb 2 inclusive and `GRACE_EXPIRED` from 00:00 org-time on Feb 3 — asserted at each boundary date, evaluated in the organization's timezone, with a test that fails if UTC or server-local time is used.
- [x] `graceDays: 0` makes the deadline the due date itself; negative or non-integer values are rejected at validation.
- [x] A `GRACE_EXPIRED` organization is still ACTIVE and fully functional, and appears in the admin review queue.
- [x] No job, action or code path sets `status = SUSPENDED` from billing state — verified by test.
- [x] Changing `Organization.graceDays` leaves every outstanding invoice's deadline unchanged, and applies to the next invoice issued — asserted with an invoice open at the time of the change.
- [x] Extending an outstanding invoice moves its deadline, and an extension past today returns it from `GRACE_EXPIRED` to `DUE` and clears the review flag.
- [x] A DIRECTOR cannot read or write `graceDays` or `graceExtensionDays` through any route or server action; both are SUPER_ADMIN-only and audited with before/after values and the actor.
- [x] `graceDays`, `graceDaysApplied`, `graceExtensionDays` and the review fields appear nowhere in a director-facing **serialized payload** — asserted against route-handler JSON and the RSC payload/server-action return values, not against the rendered DOM.
- [x] Acknowledging a flagged invoice with a note removes it from the unreviewed queue while leaving it `GRACE_EXPIRED`, unpaid, present in the outstanding-invoices view and in overdue totals, with the director's banner unchanged.
- [x] Acknowledge → extend (invoice returns to `DUE`) → let the new deadline pass: the invoice reappears as a **fresh unreviewed item**, because `reviewAcknowledgedForFlaggedOn` no longer matches the new `flaggedFrom`.
- [x] Expiration begins exactly at midnight: at `23:59:59.999` org-time on `graceEndsOn` the invoice is `DUE`, and at `00:00:00.000` on the next day it is `GRACE_EXPIRED`. Both instants asserted.
- [x] Acknowledgment-key equality is compared by canonical date value: a test that acknowledges and then re-reads with a freshly constructed equivalent date still shows the invoice as reviewed (this fails if `Date` object identity or reference comparison is used anywhere in the path).
- [x] Invoices are only ever created by a SUPER_ADMIN action; no job or cron creates one — verified by test. Creation snapshots `graceDays` into `graceDaysApplied` and is audited.
- [x] With no code running in between, an unpaid invoice's state still moves `CURRENT → DUE → GRACE_EXPIRED` purely as dates pass (evaluated on read), and no invoice is marked paid and no organization suspended as a result.
- [x] Recording a payment clears the banner and flag and writes an audit row.
- [x] Platform billing fields and UI are entirely separate from the student Pagos section; no shared model or route.

### Implementation record

**Routing: `/platform/**`, not `/admin/**`** — see this phase's own opening paragraph for the full reasoning. Found and decided during the brainstorm, before any code was written, precisely so it never became a choice between "rename the new pages" and "rename the three already-shipped ones."

**`AuditLog` moved into `TENANT_SCOPED_MODELS`.** Investigated, not assumed, per the brainstorm's own instruction to report what specifically blocks it rather than dropping the idea: the blocker was that roughly 16 of 23 existing `AuditLog.create` write sites across the codebase carried only `academyId`, not `organizationId`, in their `data` — the tenant guard requires the literal `organizationId` field (or an `organization: { connect }` relation), and a bare `academyId` doesn't satisfy it. Fixed by adding `organizationId` to every one of those writes (the value was already in scope at every site — `context.organizationId`, `student.organizationId`, or equivalent — nothing needed deriving). Two genuinely platform-level exceptions needed `unscopedPrisma` explicitly rather than an `organizationId`, since a literal JS `null` does not satisfy the guard's own non-empty-string check: the `isSuperAdmin` grant/revoke audit rows (`organizationId: null`, matching the schema's own doc comment on that column's nullability), extracted into `grantSuperAdminFlag`/`revokeSuperAdminFlag` in `platform-lookups.ts` rather than left inline in the route's own actions file.

**A real bug the investigation caught, unprompted:** `admin/branding/actions.ts`'s logo-upload rate limiter counted an actor's recent uploads via `prisma.auditLog.count({ where: { actorId, action, createdAt } })` — no `organizationId` anywhere. Before this phase, that silently counted a director's upload attempts **across every organization they belong to**, not just the one they were uploading for — invisible, because a query with no scoping filter that happens to return a small number doesn't look wrong. The guard caught it the moment `AuditLog` became scoped (an integration test failed with `UnscopedTenantQueryError` — the exact "loud failure, not a silent wrong answer" the guard exists to produce). Fixed by adding `organizationId` to the rate-limit query, which is also the more correct behavior.

**`getScopedDb`'s `ScopedDb` type gained `auditLog`.** A future director-facing audit view (see the open question above) can now read through `getScopedDb(context).auditLog` with the same automatic per-organization scoping every other model gets — no separate mechanism needed when that page eventually gets built.

**New platform-level reads live in `platform-lookups.ts`, not a second file.** A `src/lib/platform-admin/organizations.ts` was written first, then deleted and merged in — `eslint.config.mjs`'s own allowlist comment already recorded why: "every genuinely platform-level operation was extracted into named, single-purpose functions in `platform-lookups.ts`... so the bracket-as-character-class glob bug that hid three entries from this list structurally cannot recur." A second file reopens exactly that hole. Corrected before it shipped, not after.

**`requireSuperAdmin()`/`resolveSuperAdminActionContext()` re-read `isSuperAdmin` fresh from the database on every call, never from the session/JWT** — the same principle `resolveContext()`'s own `Organization.status` re-check already established for organization suspension, applied here so revoking someone's platform-admin flag takes effect on their very next request, not whenever their session happens to refresh. Verified directly, not assumed: a test grants, confirms success, revokes, and confirms the very next call is refused with no session change in between.

**Self-revocation is disallowed outright**, decided during the brainstorm rather than left as an open UI question: with `requireSuperAdmin()` re-reading fresh every request, a self-revoke would lock the actor out of the very page they're using to manage this, mid-session, with no legitimate workflow lost (asking another platform admin achieves the same thing without the surprise).

**Two things flagged, not silently built or silently dropped:** impersonation (its own open question, above) and a director-facing audit view (its own known-future-need note, above). Both were named in the original doc text or implied by existing audit infrastructure; neither is delivered in this phase.

**Billing shipped as its own PR**, as decided during the brainstorm — its own Implementation record entries follow.

**`src/lib/billing/deadline.ts` is the one place every derived billing value is computed — nothing is stored.** `resolveInvoiceState`/`graceEndsOn`/`flaggedFrom`/`isUnreviewed`/`toDateKey` are pure functions taking `timezone` as an explicit parameter (never a default), so a caller cannot accidentally reach for `America/Costa_Rica` when the invoice belongs to a different organization. Verified against the doc's own exact worked example (Jan 28 due date, 5 grace days → `DUE` through Feb 2 inclusive, `GRACE_EXPIRED` from Feb 3 00:00:00.000) as a direct unit test, not inferred from the formula reading correctly.

**The director-facing DTO (`src/lib/billing/banner.ts`) is a genuinely separate function from the platform admin's own read (`platform-lookups.ts`'s `resolveOrganizationDetailForPlatformAdmin`), not the same data with fields hidden at render time.** `DirectorBillingBanner` has exactly three fields — `state`, `dueOn`, `deadline` — and the function that produces it never reads `graceDays`/`graceDaysApplied`/`graceExtensionDays`/`reviewAcknowledgedForFlaggedOn` past the point they're needed to compute those three values. Asserted directly against the object's own `Object.keys()`, not against the rendered DOM, per the doc's own explicit instruction on what "not visible to directors" has to mean.

**One pre-existing gap found and fixed while checking the doc for staleness before implementing:** `onboarding/page.tsx`'s own `prisma.organization.findUniqueOrThrow` had no `select` at all — the entire `Organization` row was pulled into a director-facing server component's scope, safe today only because nobody happened to spread the whole object into a client prop. Tightened to an explicit 4-field `select` (the only fields this file ever reads) before `graceDays`/`billingNote` existed to make the gap consequential — the doc's own "select explicit field lists for organization reads on director surfaces" rule, applied to a call site that predated the rule.

**The admin organizations list's new billing column/filter computes state via one extra `invoices` include per query, not a query per organization** — same reasoning as the existing `branchCount`/`studentCount` aggregates on that same list (`listOrganizationsForPlatformAdmin`'s own doc comment).

**Billing never touches `Organization.status`, by construction, not by convention.** Every billing action (`billing-actions.ts`) writes only `OrganizationInvoice` or `Organization.graceDays`/`billingNote` — none of them reaches the `status` column at all, verified directly by a test that deeply expires an invoice and confirms the organization is still `ACTIVE` throughout.

**Two bugs found only by the mandatory live-browser verification step, invisible to all 14 automated tests passing at the time:**

- **A `z.strictObject` schema silently rejected every real form submission.** `createInvoiceSchema` used `z.strictObject`, the choice this doc's own registration-form correction established for public, unauthenticated endpoints. But `createInvoiceAction` is bound (`createInvoiceAction.bind(null, organizationId)`) for `useActionState`, and Next's Server Actions runtime injects its own hidden field into the submitted `FormData` to carry that bound argument across the wire — a field `z.strictObject` treats identically to an attacker's. The browser submission returned a 200 with no visible error and created nothing; the automated tests never caught it because they construct `FormData` directly in Node, bypassing whatever Next's real form-submission path adds. Fixed by switching to plain `z.object` — the earlier correction's threat model (an unauthenticated public form accepting attacker-controlled extra fields) doesn't transfer to a SUPER_ADMIN-only, bound-action, authenticated form; the extra field there is the framework's own trusted plumbing, not adversarial input.
- **Invoice dates were silently off by one day.** `createInvoiceAction` wrote `new Date(dateString)` — UTC-midnight parse — but `deadline.ts` reads every date back via `DateTime.fromJSDate(date, { zone: organization.timezone })`, which converts that UTC instant into the organization's own zone before taking the calendar date. For any timezone west of UTC (Costa Rica included), that conversion lands on the *previous* calendar day. A due date typed as Aug 28 computed a deadline of Sep 1 instead of the correct Sep 2 — caught only by reading the rendered page after a real submission, not by any assertion, since the existing automated tests query for the row they just created rather than asserting its calendar date against what was typed. Fixed by anchoring the write to the organization's own timezone via Luxon (`DateTime.fromISO(dateOnly, { zone: organization.timezone }).startOf("day").toJSDate()`), matching the read side. A prior test assertion (`findFirstOrThrow({ dueOn: new Date("2026-03-28") })`) had been relying on the same buggy UTC-midnight encoding to find its own row and was rewritten to not depend on it.

**A test that only passed because the machine running it happened to share Costa Rica's UTC-6 offset — closed structurally, not by fixing the one test.** The state-transition test above (`CURRENT -> DUE -> GRACE_EXPIRED` purely as dates pass) built its probe instants via `DateTime.now()` in the test runner's own system zone, then compared them against a `dueOn` value that (after the fix above) is anchored to the organization's timezone. On this project's own development machine (`America/Guatemala`, also UTC-6, no DST) the two zones agreed by coincidence and the test passed; the same test failed the moment it ran on GitHub Actions (system zone UTC). Fixed the same way as the invoice-date bug: anchor the test's own `dueOn` and every "+N days" probe to `org.timezone` explicitly, never the system zone.

That coincidence is the general failure mode, not a one-off: **a test whose result depends on the zone of the machine running it isn't testing the code, it's agreeing with its environment — and the only way to find those is to change the environment.** All three `vitest.*.config.ts` files now force `process.env.TZ = "Pacific/Kiritimati"` (UTC+14, ~20 hours from Costa Rica's UTC-6 and almost never sharing a calendar date with it — plain UTC was considered and rejected as only 6 hours off, too close to UTC-6 to reliably cross a date boundary) at the top of the config file itself, before `defineConfig` runs. Per Vitest's own documentation, this specific placement matters: setting `TZ` via `test.env`, a setup file, or inside a test has **no effect** under the default `pool: 'threads'` (each worker inherits the main process's environment only at spawn time); the config file's top level runs in the main process before any worker pool starts, which is the one place the setting reliably takes hold. Verified directly, not assumed: a scratch test asserted `Intl.DateTimeFormat().resolvedOptions().timeZone === "Pacific/Kiritimati"` inside a real Vitest worker before this was trusted.

Run under that hostile zone, the full suite (357 unit + 498 integration tests, after the fix above) passed clean — no further failures surfaced. Read correctly, that result is narrower than it sounds: it means `deadline.ts`, `banner.ts`, and `promotion/automation.ts` (the three places that read `Organization.timezone` as an explicit parameter) are genuinely zone-safe, and it means the hostile-zone run itself works as a mechanism. It does **not** mean the rest of the scheduling/attendance code is multi-timezone-safe — that code doesn't read the ambient system zone at all, hostile or otherwise, so the hostile-zone run was structurally incapable of exercising it. It converts through one hardcoded module constant regardless of which organization is asking. See below for what that actually means and how large fixing it is.

**Reframed, not "a DST gap": this platform is single-timezone while presenting itself as multi-tenant, and `Organization.timezone` is a column no scheduling code reads.** `src/lib/scheduling/zone.ts` declares `export const ZONE = "America/Costa_Rica"` as a module-level constant, and every scheduling/attendance function in that file plus `check-in-window.ts` converts through it — never through the organization the request actually belongs to. This is this project's own recurring shape (a mechanism built, a caller that should read it left on the old path): the column exists, the schema carries it, `deadline.ts`/`banner.ts`/`automation.ts` already prove the correct pattern (`prisma.organization.findUnique({ select: { timezone: true } })` → `DateTime.now().setZone(org.timezone)`), and 21 other call sites don't use it.

**What goes wrong, concretely, per surface — not DST-only, plain wrong-day for anyone outside UTC-6:**
- **`toAttendanceDate`/`attendanceDateFromZoned` (`zone.ts`)** — converts a real check-in instant to the CR calendar day it falls on. For an org outside `America/Costa_Rica`, this is wrong *today*, with no DST transition required: an academy in Santiago (`America/Santiago`, UTC-3/-4) checking a student in at 8pm local converts through Costa Rica's UTC-6 instead, landing the `AttendanceRecord.date` on the wrong calendar day — silently, in the exact data `getBeltSummary`'s attendance-count promotion mode counts toward a belt. This is Phase 5's own live-customer risk the moment an org outside UTC-6 signs up, independent of whether that org's zone observes DST.
- **`getCheckInWindow`/`matchOccurrence`/`startOfOccurrence` (`check-in-window.ts`)** — the ±30-minute check-in window around a class's scheduled start is computed in CR wall-clock time regardless of the academy's real zone, so a real class's actual local start time falls outside the window the code thinks it's in.
- **`weekly-digest.ts`'s trailing-7-day window** (`DateTime.now().setZone(ZONE)`) — the digest's "this week" boundary is CR's own day boundary, not the recipient organization's, so the attendance count it reports can include or exclude a day the organization itself wouldn't.
- **Billing's own due-date math (`deadline.ts`)** — already reads `Organization.timezone` correctly by construction, so it is not in the "wrong today" category above. It is, however, unverified across an actual DST transition (a spring-forward/fall-back boundary landing inside a grace window) — Luxon's calendar-day arithmetic should handle it correctly, but that specific case has never been exercised by a test the way the doc's own worked example exercised the non-DST boundary.
- **Every other direct `ZONE` importer** (17 files: `analytics/{retention,progression,franja-heatmap,filters}.ts`, `payments/get-current-period.ts`, `students/{attendance-summary,contact-list}.ts`, the dashboard/students/admin-schedule/portal/kiosk-tokens page components, `kiosk-client.tsx`) — each computes "today" or a date window in CR time for whichever organization is asking, so every analytics window, "days since last attendance" figure, and kiosk-token day boundary is wrong for a non-UTC-6 organization in the same way.

**Sized, not just flagged.** This is not a bounded fix or a single PR:
- **Core (2 files):** `zone.ts` and `check-in-window.ts` — roughly 6 exported functions (`crDayOfWeek`, `toAttendanceDate`, `getCheckInWindow`, `matchOccurrence`, `startOfOccurrence`, and `attendanceDateFromZoned`'s callers) need `timezone` added as a required explicit parameter, no default — matching `deadline.ts`'s own "never default, always explicit" precedent, deliberately, so a caller can't silently fall back to Costa Rica the way the current constant does.
- **Context plumbing:** none of `TenantContext`, `SystemJobContext`, or `KioskContext` (`src/lib/tenant/types.ts`) currently carries `timezone` at all. `resolveContext()`'s existing `organization.findUnique` (`context.ts`) already selects that row for `status` — adding `timezone: true` is one field, zero extra queries — but `SystemJobContext`'s own resolution and all three `KioskContext` construction sites (`api/kiosk/check-in/route.ts`, `api/kiosk/reassign/route.ts`, `kiosk/[academySlug]/page.tsx`) need the same one-field addition threaded through, since none of them read it today.
- **Call sites: 21 files** import `ZONE` or a `ZONE`-backed helper directly (confirmed by grep, not estimated) — 17 read `ZONE` itself for their own `DateTime` math, 4 more call helper functions that hide the same constant internally. Each needs its local usage swapped from the constant to the resolved organization's timezone.
- **Tests: 19 files** touch this surface today (`tests/unit/check-in-window.test.ts` plus 18 integration test files spanning attendance, promotion, payments, kiosk, and every analytics suite). Removing the hardcoded default (rather than adding one to paper over the gap) means every test call into these functions needs an explicit timezone argument added to keep compiling — mechanical, but real volume, likely the single largest line-count chunk of the work.
- **Not pure plumbing — one real design decision.** A parameter rename would be a day's work; what makes this bigger is that a real DST-observing organization introduces genuine new cases with no existing precedent in this codebase: a class scheduled during the "spring forward" missing hour, or during the ambiguous repeated hour on "fall back." `deadline.ts`'s calendar-day arithmetic likely absorbs this correctly by construction, but the check-in window's ±30-minute wall-clock math and the attendance-date derivation need an actual decision about what happens in those two edge cases, then a test proving it — the same rigor `deadline.ts` got for its own boundary, not assumed by analogy.

**Estimate: phase-sized, not PR-sized** — on the order of a focused week, not a day: two core files with real design decisions, three context types threaded through their resolution points, 21 call sites, and a test surface (19 files) large enough that most of the calendar time goes to mechanically updating call sites and their tests once the core design is settled, not to the core logic itself. Not scheduled now — Costa Rica is the current market and every existing organization is UTC-6 — but sized here so it is a planned decision the day an organization outside `America/Costa_Rica` signs up, not a discovery made by one.

---

## Phase 7 — Consolidated i18n, tests, and parity verification

Phase 7 consolidates verification. It is **not** the first time these checks run — tenancy and Alliance parity verification run after every relevant phase, against the Phase 0 baseline. Re-scoped in revision 28 against what actually already existed rather than built to this list as originally written — see that revision's own entry for the evidence behind each line below.

- [x] Every new string exists in both `messages/es.json` and `messages/en.json`; a test asserts key parity. `tests/unit/messages-key-parity.test.ts`, new. (The "no hardcoded user-facing literal" half was done as a one-time grep sweep instead of an enforced rule — see below — since a lint rule built on spec costs more than it saves for a risk that turned out to be zero real instances.)
- [x] A one-time sweep for hardcoded user-facing literals, evidence-based rather than an enforced lint rule. 23 raw hits, 0 real bugs (locale-picker language names, dev-only unlinked pages, `sr-only` shadcn boilerplate). Revisit a lint rule only if a future sweep finds dozens, not a handful.
- [x] Rank labels come from the rank rows (`labelEs` / `labelEn`), not from translation files — confirmed already true since Phase 2/3 (`BeltRank.labelEs`/`labelEn`, used across the app); nothing to build.
- [x] Vitest coverage for: tenant isolation across all query shapes, promotion engine (all modes, cumulative attendance, terminal ranks, invalid config, negative totals, month boundaries), belt display derivation, theme/contrast, logo validation, registration + idempotent approval, admin authorization — all already had dedicated test files, confirmed by existence and spot-checked for substance, not merely by file name.
- [x] Invitation tokens: expiry specifically was untested (the code checked it, nothing proved the check worked) — added to `organization-approval.test.ts`.
- ~~Impersonation expiry~~ — removed. Impersonation was never built (Phase 6's own open question); there is nothing to test.
- [x] Tenancy verification and Alliance parity verification both pass against the Phase 0 baseline — confirmed already continuous, not a one-time Phase 7 task: `check:guard-usage`, `db:check-drift`, and `ci:parity-check` all run on every CI build.
- [x] `docs/REDESIGN_BRIEF.md` audited (not blindly rewritten or deleted) and kept, with a status note added — see revision 28.
- [x] `docs/MULTI_ACADEMY_OPERATIONS.md` written for Alexis as an operator: approving an academy, bootstrapping a platform admin, suspending/reactivating a non-paying organization, issuing or resending an invitation, running the approval CLI when the panel is down, checking whether the weekly digest fired.
- [x] README updated: every environment variable now documented (there were none before), plus the platform-admin bootstrap procedure (didn't exist anywhere before this).

---

## Phase 8 — Dashboard analytics: attendance by class

### Goal

The weekly attendance trend answers *"is the academy growing?"*. It does not answer *"which classes actually fill up?"* — the question that decides whether the 6am GI stays on the schedule. Add a companion **bar chart of attendance by class**, in the same visual language as the existing trend line.

### Data

- **Reuse the existing attendance aggregation.** Do not write a second counting function: the numbers in this chart must reconcile exactly with the weekly trend and with the student counts. If the trend counts by summing `AttendanceRecord.delta`, so does this.
- **Exclude onboarding credits** (Phase 3). They are promotion-relevant but nobody attended a class, so they belong to no class and no week. Structurally true, not enforced by a flag check: `PromotionCredit` (Phase 3d's own ruling) is a separate table, never a row in `AttendanceRecord` at all — so neither this chart nor the weekly trend can include one, by construction.
- Group by class (the schedule entry — "Lunes 6:00 GI principiantes"), not by individual session.
- **No range selector.** This was a drafting inconsistency in this doc, not a real requirement — corrected in revision 28 rather than built around: Panel (where "Placement" below puts this chart) has no filter controls at all, and the 7/30/90-day quick range this bullet originally described only exists on the separate `/dashboard/analytics` page. This chart shares the weekly trend's own fixed 8-week window (`WEEKLY_CHART_WINDOW_WEEKS`) — one window, two views of it, no control to build.
- Organization-scoped, branch-filtered by the viewer's permitted branches. Carry the same cross-branch caption the trend chart uses ("cuenta por sede de entrada…"), since a student training at both locations appears under the class they attended.
- Sorted by count descending. Show the top 10 with a "ver todas" expansion; do not render 30 bars by default.
- **Is this the same feature as `getClassPopularity`/class-popularity-panel.tsx (`/dashboard/analytics`)?** Same underlying question ("which classes fill up") and the same reused counting logic (see Implementation record), but deliberately not the same surface: Resumen's version is the filterable deep-dive (adjustable 7/30/90/Año range, previous-period comparison, growth movers, at-risk list) a director visits to analyze; this one is a zero-setup companion to the trend a director sees the moment they open Panel, sharing that trend's own window with no filtering to configure. Two different moments, one shared aggregation — not two competing answers to one question.

### Chart form

**Horizontal bars.** Class names are long ("Miércoles 6:30 competición") and vertical bars force rotated labels, which are slow to read and collide at narrow widths. Horizontal bars give every label a full readable line.

Specifics:

- **One measure across categories = one color.** A single series takes a single color — do not assign a different hue per class. Rainbow bars imply a categorical encoding that isn't there, and they break the moment the filter changes which classes survive.
- No legend for a single series; the chart title names the measure.
- 4px rounded ends on the data end only, anchored flat to the baseline. Thin bars with a 2px gap between them.
- Recessive axes and gridlines — light, thin, behind the data. Value labels at the end of each bar; no axis clutter duplicating them.
- Hover tooltip per bar: class name, count, and the count's share of the range total.
- **Dark mode is chosen, not flipped.** Pick the dark-surface bar color deliberately and check it against the dark background; do not auto-invert the light one.
- Empty state ("sin asistencias en este rango"). No loading skeleton: like the weekly trend beside it, this chart's data is resolved server-side before the page ever renders — there is no client-side fetch for a skeleton to ever cover, and building one would be dead code with no code path that shows it.
- Accessibility: a table view of the same data reachable from the chart, and an accessible name per bar. Identity must never rest on color alone.

### Placement

On the director dashboard (Panel), directly below the weekly trend, full width, sharing its exact fixed window (see "Data" above — no range control exists on this page for either chart to share). **Not ADMIN/DIRECTOR-only like the weekly trend it sits beside**: Panel is a page INSTRUCTOR also reaches, and `getAttendanceByClass` carries no role check beyond that — an INSTRUCTOR sees this chart scoped to their own assigned academies via `branchScopeWhere`, the same mechanism that already scopes every other INSTRUCTOR-visible query on Panel, not a new or different rule invented for this chart. The weekly trend and belt-distribution panel above it remain ADMIN/DIRECTOR-only, unchanged.

### Acceptance criteria

- [x] Totals in the bar chart reconcile exactly with the weekly trend over the same window and branch filter — both draw from the same `countCheckinAttendances`/`branchScopeWhere` primitives (`class-popularity.ts`), never two independently-written queries.
- [x] An instructor sees only their own assigned academies' classes; a director/admin sees every class in their organization scope; no class from another organization ever appears — enforced by `branchScopeWhere`, asserted directly by a test.
- [x] A single color is used for all bars; no per-class hue assignment exists in the code. Fixed, non-brand-configurable (`--data`, never `--brand-gold`) — see the Implementation record's own account of where that already went wrong.
- [x] Filtering to fewer classes (the "ver todas" expansion) does not repaint the survivors a different color — every bar always renders `bg-data`, unconditionally.
- [x] Long class names render fully, unrotated and untruncated, at 1280px and at phone width — achieved by a label-above-bar layout (see Implementation record on why not a recharts category axis), never truncated.
- [x] Hover tooltip shows class, count and share; a keyboard user can reach the same information via the explicit table-view toggle, not a hidden sr-only twin.
- [x] Dark mode uses its own selected, measured-contrast bar color, not an auto-inverted one — see globals.css's own recorded ratios.
- [x] Empty state renders correctly with a new organization that has no attendance yet.

### Implementation record

**A pre-existing bug found before a line of new UI was written**, not a hypothetical this phase's own color rule was written to guard against: `WeeklyAttendanceChart`'s line/area and `BarList`'s own default fill both used `var(--brand-gold)`/`bg-brand-gold` — the director's own configurable brand color (`branding-scope.tsx` overrides `--brand-gold` per organization). `class-popularity-panel.tsx` (the closest existing sibling to this phase's own chart) never overrode that default, so a pale brand color already made its bars nearly invisible, live, before this phase touched anything. Fixed at the root, not per call site: `BarList`'s default became `bg-data` instead of `bg-brand-gold`, which fixed `class-popularity-panel.tsx` with no change to that file at all — the two callers that already override it with belt colors (`dashboard/page.tsx`'s belt distribution, `progression-panel.tsx`) were correctly left untouched, since a belt's own color IS its data, not this bug. `WeeklyAttendanceChart` was retrofitted the same way, directly.

**`--data`/`--data-muted` are new, deliberately not derived from the existing unused `--chart-1`...`--chart-5` scaffolding.** Those shadcn defaults were never wired into any chart in this codebase, and inspection showed why: light-mode `--chart-1` (`oklch(0.87 0 0)`) is too light to clear 3:1 against a near-white `--card`, and `.dark`'s values were identical to `:root`'s, never actually adapted. Real values were computed via an actual oklch → linear-sRGB → WCAG relative-luminance conversion, not eyeballed: light `--data` (`oklch(0.46 0.14 255)`) measures 7.20:1 against `--card`, dark `--data` (`oklch(0.68 0.13 255)`) measures 6.21:1 against dark's `--card` — both comfortably clear the WCAG 1.4.11 3:1 floor for non-text graphical objects, with `--data-muted` clearing it too (3.64:1 light, 3.69:1 dark). Hue 255 (blue, matching this codebase's own `--class-gi`) was chosen specifically because it's as far as two hues get from gold's own hue (85) — a director's brand color would have to independently land on a very similar blue to visually merge with chart data, the same irreducible risk every other fixed semantic token (`--ok`/`--warn`/`--bad`/`--class-*`) already accepts.

**Verified live, not just computed**: a real branding save to a deliberately pale color (`#FFFDE7,` which passes this codebase's own WCAG-on-text check for the branding form — that check is for text-on-button contrast, a different pairing than "bar fill against card," which is exactly why it didn't catch this) made the sidebar's own active-nav chrome nearly unreadable while the weekly trend, the new attendance-by-class chart, and class-popularity's bars all stayed the same legible blue — screenshotted in both light and dark, then the branding was reverted.

**The doc's own "Data" section had an internal inconsistency** (a 7/30/90-day range selector that only exists on a different page), corrected in revision 28 rather than built around — see that revision's own entry. This chart shares the weekly trend's fixed 8-week window; no new filter control exists.

**Not built with recharts, deliberately.** This codebase's only recharts usage (`WeeklyAttendanceChart`) is a continuous line/area; every existing categorical ranking (`BarList`, used by class-popularity and belt distribution) is already a plain div/CSS-grid bar. A recharts category (Y) axis sized for long class names at phone width is a known, awkward tradeoff — either a fixed-width axis eats the chart's own space on narrow screens, or labels get truncated, directly contradicting this phase's own "render fully, unrotated, untruncated" requirement. A label-above-bar div layout sidesteps the problem entirely and stays consistent with this codebase's existing convention for exactly this kind of data, rather than introducing a second one.

**`getAttendanceByClass` shares its counting logic with `getClassPopularity` through two extracted private helpers** (`resolveClassSessionsInScope`, `countCheckinAttendances`) in `class-popularity.ts` — one definition of "which `ClassSession`s are in scope" and "which `AttendanceRecord`s count toward them in a window," not two independently-written queries. `getClassPopularity`'s own existing tests were re-run unchanged after the refactor and still pass, confirming its external behavior didn't shift.

**Is this the same feature as class-popularity, shipped twice?** Investigated directly, not assumed either way — see "Data" above for the argument this doc is making explicitly: same reused aggregation, deliberately different surfaces (a zero-setup companion to the trend on Panel vs. a filterable deep-dive with growth/movers context on Resumen), not two competing answers to one question.

**`getAttendanceByClass` carries no role check, unlike `getClassPopularity`'s own ADMIN/DIRECTOR throw** — Panel is a page INSTRUCTOR also reaches (unlike `/dashboard/analytics`, absent from INSTRUCTOR's own nav), so the function relies entirely on `branchScopeWhere` to narrow an INSTRUCTOR to their own assigned academies, the same mechanism already scoping every other INSTRUCTOR-visible Panel query — not a new or different rule invented for this chart. Asserted directly by a test creating two academies in the same organization and confirming an INSTRUCTOR assigned to only one never sees the other's class.

**A real, live gap found while writing `docs/MULTI_ACADEMY_OPERATIONS.md`, folded into this phase**: resending an invitation for an already-ACTIVE organization had no panel button anywhere — only `scripts/approve-organization.ts`, since the pending queue's own "Approve" button only ever renders for `PENDING` organizations. Fixed with a new `ResendInvitationButton` on the organization detail page's members card, calling the exact same `approveOrganizationAction` the pending queue's own Approve button calls — no new server action was needed, since `approveOrganization()` already accepts `PENDING` or `ACTIVE` and is already idempotent on the latter.

---

## Launch checklist — deliberately deferred items, and what each one blocks

Everything below was deferred on purpose somewhere in this doc's revision history, not
discovered here for the first time — this list exists to put them in one place with a real
judgment on each: does it block Alliance's own launch, or only a future customer's? Alliance is
the only organization today, is `America/Costa_Rica` (UTC-6), and Alexis is the only platform
admin — several items below genuinely don't matter yet for exactly those reasons. The point of
this list is that that's a decision made from evidence, not a gap nobody looked at.

| Item | What breaks if it ships unaddressed | Blocks |
|---|---|---|
| ~~**No way to create a second location**~~ — **built in revision 38 (B3)** (`/admin/locations`, Owner-only and add-only: name, optional address, kiosk token shown once, default payment plan, audited) | *Was:* Alliance has two locations, Escazú and Escalante, and registering it through the real flow yields one academy with no page to add the other. | **No longer blocks.** Three things it deliberately does not do: rename, edit the address of, or deactivate a location; and the first academy is named after the registration city and cannot be renamed — check Alliance's before launch. |
| ~~**The kiosk check-in screen shows "NaN"**~~ — **fixed in revision 39 (#47)**; found in revision 38, in a real browser (the fourteenth "built it, never wired it" instance) | *Was:* every real check-in, at every organization, showed "1 / NaN" and "NaN attendances to go for your next stripe": `kiosk-client.tsx` read `remainingToNextStripe` and `examEligible`, the API returns `remainingAttendance` and `isEligible`. | **No longer blocks.** The client's `summary` is now a `Pick` of the server's `AtBeltSummary`, so a rename is a compile error, and tests render the screen from that type. |
| ~~**No staff management**~~ — **built in revision 35** (`/admin/staff`, Owner-only: invite by email with a role and academies, edit, deactivate/reactivate per organization, resend/revoke invitations, a copyable link) | *Was:* Alliance could not add a single instructor, and a per-location director could never be appointed. | **No longer blocks.** Two things it deliberately does not do: a director is not limited to one location, and one location does not get at most one director (the roles say "runs one location", the tool only enforces "at least one academy") — see revision 35. |
| ~~**No real student could reach the student portal**~~ — **fixed in revision 37 (B0)**; found in revision 36 while researching B4, by signing a student up through the public form and logging in | *Was:* a self-registered student got a `User` and a `Student` and **no `OrganizationMembership`** — the row `/portal` (through the tenant-context resolver) requires — so an approved student logged in to "No organization access — Your account isn't linked to any organization". Only the seed, which hand-writes its students' memberships, ever made the portal work. Alliance's students outnumber its staff by roughly fifty to one, and not one of them could have used it. | **No longer blocks.** Staff approving a student now creates their `STUDENT` membership; archiving switches it off. Students approved before this change have no membership (none exist in production; a development database that has them needs a one-off backfill). |
| ~~**Archiving a student is permanent, and the dialog claims it isn't**~~ — **built in revision 39 (B5)**: an ARCHIVED student can be restored, from a stored `statusBeforeArchive` (never the audit log); the dialog now says "you can restore them later" | *Was:* the archive confirmation said "This can be reversed by editing status later", `status` is deliberately not editable, and since B0 archiving also switched off portal access, so there was no route back. | **No longer blocks.** A student archived before the column existed restores to PENDING, never guessed as approved (one click from ACTIVE) — see revision 39. |
| ~~**A student who logs in before approval sees "not linked to any organization"**~~ — **fixed in revision 39 (B5)**: `/no-organization-access` says the registration is awaiting approval, naming the academy, from the user's own PENDING `Student` record | *Was:* it read as an error, so a new student would message the academy and the academy would message the platform admin. | **No longer blocks.** |
| ~~**`acceptInvitation` overwrites an existing account's password**~~ — **fixed in revision 35**, with its own failing test first | *Was:* someone who already had an account, invited into a second organization, silently lost their password; reachable at bootstrap through the runbook's step 9. | **No longer blocks.** An existing account keeps its password, is not signed in by a link, and gains the membership; only a brand-new account sets one. The runbook's "do not open that email" warnings are deleted. |
| ~~**A student account cannot also be staff**~~ — **fixed in revision 40 (B4)** (found in revision 35, reclassified as a blocker in revision 36; a consequence of the global `User.role`, which gates the whole route tree — `/dashboard`, `/students`, `/admin` require a staff role, `/portal` requires `STUDENT`) | *Was:* an Owner who invites an address that already belongs to a *student's* login is refused (`studentAccount`), because a single account cannot be both: whichever role `User.role` holds, one side of the app would send them to the login page. In a jiu-jitsu academy **every instructor is a student** — the head coach trains there, the purple belt covering Tuesdays trains there, and Alliance's whole coaching staff already exists as student records with student logins — so this is hit at every staff invitation, not the first. The second-email workaround makes it permanent: one person, two identities, checking in for their own training under one and taking attendance under the other, belt progress in one and teaching in the other. | **No longer blocks.** Access is now the membership, not the global role: the middleware gates on a `{ staff, portal }` claim derived from the database, every page re-derives it, a stale claim is refreshed, and an invitation to a student's address promotes them in place. |
| **No verified Resend sending domain** (`EMAIL_FROM` still points at `notifications@resend.dev`, Resend sandbox mode) | Resend's sandbox only delivers to the Resend **account's own** verified email address. Every other recipient — every real director, every real student, every real staff member — silently never receives their invitation, password reset, or digest email. This is not a future-customer problem; it breaks Alliance's own onboarding today. | **Alliance's launch.** Get a verified sending domain in Resend and update `EMAIL_FROM` before any real user needs to receive an email. |
| **No terms-of-service document** (`register-academy`'s checkbox says "I agree to the terms" and stores `termsAcceptedAt`, but nothing exists for anyone to read or link to — confirmed: no `/terms` route, no linked document anywhere) | Every organization that registers is asked to agree to terms that don't exist. This is a legal-exposure question, not a technical one — I can't size the risk, only confirm the gap is real. | **Alliance's launch, if you register Alliance itself through this flow — otherwise a decision only you can make, not a technical blocker.** Flagged here because nobody had confirmed the document didn't exist; whether that's acceptable for a v1 with one customer is a business call. |
| **Single-timezone platform** (`ZONE = "America/Costa_Rica"` hardcoded in scheduling/attendance/the weekly digest; see revision 27's own entry for the full breakdown and size estimate) | An organization outside `America/Costa_Rica` gets silently wrong attendance dates, check-in windows, and digest windows — not a DST-only issue, wrong from day one for that org. | **Only the second customer** — Alliance is UTC-6, so this cannot manifest for Alliance itself. Sized already (phase-scale, ~a week) so it's a scheduled decision once a non-Costa-Rica organization is close to signing, not a scramble. |
| **DST specifically** (a subset of the above — even a UTC-6-hardcoded org's own billing math has never been exercised across a real DST transition) | Same root cause as above; billing's `deadline.ts` already reads `Organization.timezone` correctly and should handle it by construction, but that specific case has no test proving it. | **Only the second customer**, and only one in a DST-observing zone. Costa Rica itself never observes DST, so Alliance can never trigger this. |
| **Currency (revision 34) — handled, with one boundary** (per-organization `CRC`/`USD`, snapshotted on every payment; see revision 34) | Nothing breaks: amounts display in the currency they were recorded in and a currency change never relabels history. The one thing to remember is that **no revenue total exists yet** — the first one anyone builds must group by `PaymentPeriod.currency`, which a structural test enforces. Currency is *not* timezone: the same "assumes Costa Rica" family as the two rows above is still open. | **Neither.** Same "assumes Costa Rica" root as the timezone row, which is still the one that blocks a second customer outside `America/Costa_Rica`. |
| **Correcting a *paid* payment on a deactivated plan silently rewrites which plan it was under** (known behaviour, revision 34; the opposite direction of the currency snapshot) | Pagos offers **Edit only on promotional/exempt rows**; a *paid* row offers only "View receipt". The student-page payment form lists **active plans only**, so the one way to correct a paid payment whose plan has since been deactivated (a wrong note, method or amount) is to re-record it — and that forces a *different, active* plan onto the row. The row then says the student paid on a plan they were never on. Nothing errors and the audit row records the plan change, but **payment history can silently disagree with what actually happened**, and it surfaces months later, during reconciliation — when a director or accountant asks why a September payment sits under a plan that did not exist in September, or why a plan's payment count and revenue no longer match what was collected under it. This is the same class as the currency rule, in the opposite direction: a record of money that changed hands should not be retroactively relabelled, and the currency column was built so it never is; the plan is not protected the same way. | **Neither**, today — Alliance's early history is small and the director who made the correction is reachable. Becomes real with volume, with a second person doing corrections, and the first time anyone reconciles a period against a bank statement. **Open product decision (Alexis, later):** whether *paid* rows should get a real in-place Edit that keeps their own plan — the promo-row Edit sheet already does exactly that, tested and browser-verified, so the mechanism exists. Until then, prefer not to deactivate a plan that has payments a director is still likely to correct. |
| **Impersonation not built** (Phase 6's own open question — a platform admin "opening as" an organization) | No support workflow lets you see the app exactly as a confused director sees it without asking them to screen-share. | **Neither**, today. You're the only platform admin and Alliance is your only organization — there's no scenario yet where you need to act inside an account that isn't reachable some other way. Revisit if support load or customer count grows enough to need it. |
| **No director-facing audit view** (Phase 6's own known-future-need note — only the platform admin's own panel can read `AuditLog`) | A director asking "who changed this student's belt?" has no page to answer it; only you can look it up via `/platform`. | **Neither**, today, for the same reason as impersonation — you're reachable for that question right now. Becomes real the day a director expects to self-serve it. |
| **Real icon/logo artwork** (`src/app/icon.png` etc. are a neutral "P" monogram placeholder, not real brand identity) | Every organization's installed PWA icon and browser tab shows a generic placeholder, not a real mark. Cosmetic, not functional. | **Neither**, strictly — but visible to Alliance's own staff every day once real product use starts. Worth doing before it's `Alliance`'s own daily experience, not before launch specifically. |
| **The product itself has no chosen name** (`PLATFORM_NAME` in `src/lib/platform.ts` is a placeholder; the browser tab and pre-tenant pages literally read "[Platform name TBD]" today, confirmed live) | Same category as the icon — looks unfinished on every page that has no organization to name yet (login, the marketing home, the browser tab). | **Neither**, strictly, but same reasoning as the icon: it's Alliance's own staff who see this daily. One-line fix once a name exists (`src/lib/platform.ts`'s own comment: "the entire update once it is"). |
| **`E2E_AUTH_BYPASS_SECRET` / the e2e-auth-bypass route** | If this were ever set in a real production environment, it mints a real session for any user id a caller names. | **Neither, already defended at the code level**, not just by convention: the route itself refuses to work when `NODE_ENV === "production"`, regardless of whether the secret is set. The one operational step that matters: never set `E2E_AUTH_BYPASS_SECRET` as a Production environment variable on your host. Worth one manual check at deploy time, not a build task. |
| **Per-organization student limits / plan tiers, custom rank tracks, per-organization data export** (Appendix B's own open questions — longer-standing than this week's revisions) | Different in kind from everything above: these are product-scope questions Alexis herself flagged, not implementation gaps found during a build. | Not sized here — see Appendix B directly; these were never claimed to be resolved. |
| **Nothing validates the logo-storage config (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/bucket) at startup or on a health check** (found during PR review, revision 44's error taxonomy) | Confirmed directly: these three env vars are read nowhere outside `logo-storage.ts`, lazily, on first real upload/delete; `/api/health` is deliberately database-only and `/api/health/jobs` is deliberately job-freshness-only — neither touches storage. A missing/misspelled var in production degrades gracefully (the director sees "There's a problem with logo storage," never a crash — revision 44's own fix) but silently: nobody watching a dashboard would know until a real upload was attempted. | **Alliance's launch, as a manual step, not a build task.** `docs/DEPLOYMENT_RUNBOOK.md`'s "3. Supabase Storage" section names the concrete options (a manual first-deploy verification step, or extending `/api/health` to also ping Storage) — a decision for whoever does the deploy, not made here. |

**Read together:** one item above blocks Alliance's own launch outright — the Resend
sending domain. It used to be two: (found by driving the product as a registered owner or a registered
student instead of a seeded user) **a student account could not also be staff** (B4, found in revision 35,
reclassified from "will be hit" to a blocker in revision 36, closed by revision 40). Closed, and no longer counted: **the kiosk
check-in screen shows "NaN"** (found in revision 38, fixed in #47), **no way to create a second
location** (B3 — found in revision 33, built in revision 38, merged as #46), **no real student
could reach the portal** (B0 — found in revision 36, closed by revision 37), **no staff
management** (revision 35), and the two small **B5** items — an un-archive and an "awaiting
approval" message for a student who logs in before approval (revision 39). The version of this paragraph before revision 33
said exactly one item blocked Alliance; it was right about everything anyone had looked at,
and wrong because nobody had tried to set Alliance up through the real flow. One (terms of service) is a business decision this doc can surface but
not make for you. One more (the logo-storage config health check, found in revision 44's PR
review) is a manual verification step at deploy time, not engineering work — named here so it
isn't skipped the way an unwatched gap tends to be. Everything else either cannot affect Alliance at all (single-timezone/DST, given
Alliance's own zone) or is cosmetic/support tooling that matters once there's more than one
organization or more support load than you can personally absorb.

**As of revision 43, the launch-blocking list is empty of engineering work — see that
revision's own closing section for where the project actually stands.** The platform's own
name is still `[Platform name TBD]` throughout the UI; the Resend sending domain is named
above; the Vercel/Supabase/Healthchecks.io account setup and the deploy itself are in
`docs/DEPLOYMENT_RUNBOOK.md`. None of it is code.

---

## Appendix A — Decisions already made (do not re-litigate)

- `Organization` is the tenant; the existing `Academy` stays a physical branch. Never conflate them in the database.
- **One multi-tenant deployment, not an app per academy.** Considered and rejected: per-academy deployments multiply every migration, deploy and monitoring task by N for a solo maintainer, multiply infra cost per customer, and break the self-serve signup funnel. The decisive reason is reversibility — multi-tenant → a dedicated instance for one customer is an afternoon; single-tenant → multi-tenant is this entire project repeated with N academies' data.
- Students are entered manually at go-live. There is no GymDesk importer, and none should be built.
- **Launch sequencing: the full feature set ships before Alliance gets it.** No early pilot on a partial build. Consequently the Phase 1 backfill script will never run against real data — it is proven, kept, and effectively ceremony unless that decision changes. Do not let it constrain later schema decisions.
- The promotion **rule engine is built now**: attendance, time, hybrid and manual — but Alliance's cumulative attendance semantics are the reference behavior and must not regress.
- Attendance progress is cumulative since the belt anchor and survives stripe awards. Only belt awards reset the anchor.
- Kids belts use the Alliance preset above (5 degrees on white and grey-white, 11 on the rest), stored as data. Official-IBJJF claims require verification first.
- The belt bar always draws at most 4 tapes; degrees past 4 replace older tapes while the counter climbs to `maxStripes`.
- The belt is drawn as a realistic woven belt in inline SVG — weave, longitudinal stitching, an inset rank bar with a tail, tapes with depth — not two rectangles. The bar color comes from data, so a black belt shows a red bar.
- Promotions can be awarded from the student detail page as well as the queue, through the same award functions and the same authorization rules. Instructors get a read-only view there.
- The sidebar has its own full palette chosen independently of the brand accent, with at least 12 presets, derived-but-overridable tokens, and WCAG AA enforced rather than warned.
- Attendance by class is a single-color horizontal bar chart sharing the trend chart's aggregation and range control.
- Organization signup is a **public form creating a PENDING record**, approved by the platform admin. No instant self-serve activation.
- Branding (logo, theme) is collected in a **skippable first-login onboarding wizard** after approval, not on the public form — the public endpoint is unauthenticated and must not accept uploads. The wizard reuses the Phase 4 settings components rather than duplicating them.
- `SUPER_ADMIN` is explicitly granted through a documented bootstrap, never inferred from a form or profile field.
- Instructor awarding stays out of scope. ADMIN/DIRECTOR award; instructors view within their branch scope.
- Payment processing stays out of scope: manual paid/promo status with custom promotions.
- The kiosk stays session-less — hashed branch token plus hashed student code, existing class matching and lockout behavior preserved.
- A SUSPENDED organization's kiosk rejects check-ins server-side with a generic localized message; attendance is preserved and reactivation reuses the existing tokens.
- Unpaid organizations get a **5-day grace period** (per-organization `graceDays`) during which they stay ACTIVE and fully functional. Grace never auto-suspends; exceeding it flags the account for review and a human decides.
- `graceDays` is SUPER_ADMIN-only, snapshotted onto each invoice at issue time, and therefore applies to **future invoices only**; an outstanding invoice's deadline moves only through an explicit, audited per-invoice extension.
- All billing deadline math is calendar-day arithmetic in the organization's timezone, with the grace window inclusive of its last day.
- Platform invoices are created **manually by SUPER_ADMIN in v1** — no scheduled job, no recurrence, no proration. Billing state still evolves automatically as dates pass, evaluated on read.
- Acknowledging a review flag is not resolution: the invoice stays `GRACE_EXPIRED`, unpaid and outstanding, and a later expiration raises a fresh review item.
- Platform billing (organizations paying Alexis) is separate from the student Pagos section (students paying their academy). Same manual, no-processing approach; different models and pages.

## Appendix B — Open questions (ask Alexis, do not guess)

1. Should Alexis get a notification (email or admin badge) the day an invoice's grace runs out, or is the admin review queue enough?
2. Per-organization student limits / plan tiers — needed now, or does the manual billing-status field cover the first customers?
3. Should organizations be able to define **custom rank tracks** (a masters track, or a non-IBJJF kids system), or is editing thresholds on the two seeded tracks enough for v1?
4. Per-organization data export (CSV of students + attendance) — needed for the sales pitch, or later?

---

## Appendix C — Decisions from the Phase 1 discovery review

Answers to the questions raised after the first repository sweep. These are settled; do not re-open them in a later phase.

**1. `BeltRequirement` gets `organizationId` in Phase 1.** Phase 1's promise is that no query can cross tenants; leaving one tenant-owned table unscoped for a whole phase is a hole. It costs one column that Phase 2 drops with the table, and it makes Phase 2's branch-override inventory easier.

**2. `AuditLog` gets `organizationId`, nullable.** Deriving it through `academyId` cannot work: organization-level actions (approve, suspend, grace change, invoice) have no academy at all, so the join yields null for exactly the rows Phase 6 needs. Nullable covers genuine platform-level entries.

**3. `Notification` gets `organizationId`, and it is `NOT NULL`.** In scope, minimally — Phase 1 makes multi-organization membership real, so a notification must say which organization it belongs to. The weekly-digest cron matters most: it iterates and sends, so it derives tenant context per organization and skips non-ACTIVE ones. No new UI.

**Why this differs from `AuditLog`'s nullable column — the test is who reads the row.** `AuditLog` is read only by the platform admin, so "null organization = a platform-level entry, never visible to a tenant" has exactly one reader and one meaning; it is legible and enforceable. `Notification` is read by tenant users, so a null has no defined audience: the enforcement wrapper would have to invent a rule, and the natural fallback — show it to the recipient regardless of active organization — is a cross-tenant visibility decision made by omission. It breaks concretely for a user who belongs to two organizations, where a null-org notification appears under both or under neither and nobody decided which.

Every notification the app produces is derived from an academy, so there is nothing to backfill. Do not "harmonize" the two models into matching nullability later; they differ for this reason.

If a genuine account-level in-app notification is ever needed (password changed, welcome), give it its own model or an explicit discriminator with a stated visibility rule. Do not let nulls into the tenant-scoped table.

**4. `User.role` is removed; membership is the only authorization source.** Sequence it safely rather than in one step:

1. create the membership model and backfill it from the current `User.role`;
2. switch every authorization read to membership;
3. verify coverage — demonstrate that no code path still reads `User.role`;
4. then drop the column.

A temporary migration field is acceptable during steps 1–3 **provided nothing branches on it once step 2 lands** — it must never be a competing authorization source.

The role does **not** go in the JWT. The token carries `userId` + `activeOrganizationId`; membership and role are re-validated against the database per request, as the app already does, so revoking a membership takes effect immediately rather than at token expiry.

**Status, revision 40 (B4) — two deliberate departures from this decision, made knowingly.** (1) Steps 1–3 are done and pinned by `tests/unit/user-role-is-not-authorization.test.ts`, but step 4 (drop the column) was not taken: the column stays, marked in the schema as not an authorization source, with the test failing if anything reads it. (2) The token now carries a *derived* claim `access = { staff, portal }`, because the Edge middleware has no database and needs something to refuse on. It is a hint, not the role: it can only ever make the middleware **refuse**; every page and action still re-validates against the database per request, so a revoked membership stops working on the next request (a stale claim in the safe direction gets the page's own 404), and a claim that says *less* than the database is refreshed from it (`/api/access/refresh`) instead of being trusted.

### Before implementing: the session/JWT/middleware proposal

**Propose the design and get approval before writing any of it.** Every authorization check in every later phase inherits this shape, so it is far cheaper to argue about on paper than in a migration.

The proposal must show how organization membership and existing academy (branch) assignments compose — org scope and branch scope are two levels of filter, not one — and must answer each of the following explicitly. A proposal that leaves any of these implicit is incomplete; send it back rather than starting from it.

**1. Where `activeOrganizationId` comes from, and that it is treated as a selector.**
A cookie, URL segment or form field says which organization the user *wants*. Membership is what says they *may*. If the design reads the selector as authority anywhere, it is wrong.

**2. Two tabs, two organizations.**
A user who belongs to more than one organization will eventually have one open in each tab. If the active organization lives in mutable ambient state (a cookie), a server action fired from the first tab can execute against the organization selected in the second. Actions and mutations must carry the organization explicitly and re-derive authorization from it, not read ambient state at execution time. Show how this is prevented, not merely that it is unlikely.

**3. The kiosk on a browser that already has a session.**
Realistically the kiosk device is somebody's laptop, with a director's session sitting in the cookie jar. The kiosk path resolves its organization **only** from the verified branch token and must never inherit tenant context from a session that happens to be present. Show the kiosk request path deriving nothing from cookies.

**4. Middleware is not the gate.**
`src/middleware.ts` excludes `/api/**` from its matcher — which is exactly where the kiosk and cron routes live. Enforcement belongs in handlers and server actions; middleware is convenience and redirects, never the security boundary. The proposal must not rely on it for isolation.

**5. Platform administrators are not members.**
Acting on an organization they do not belong to needs its own explicit path — never a synthetic membership row, which is how `SUPER_ADMIN` leaks back into the per-organization role enum that decision 5 deliberately keeps it out of. Show how platform scope and impersonation (Phase 6) establish tenant context without inventing a membership.

**6. Fail-closed on absence.**
No tenant context must mean deny. Never "unscoped", never "all organizations", never a silent fallback to the user's first membership.

**7. Revocation and suspension take effect on the next request.**
A membership revoked or an organization suspended mid-session must deny the user's very next request, not at token expiry. This is why the role is re-validated against the database per request rather than carried in the JWT.

**8. Sessions in flight when the shape changes.**
Existing JWTs will carry the old shape. Say what happens to them. Pre-launch the answer is simply to invalidate all sessions — but state it, rather than leaving old tokens half-working and half-trusted.

**5. `SUPER_ADMIN` is a separate field on `User`, never a value in the per-organization membership role enum.** If it were representable as a membership role, "member of org X with role SUPER_ADMIN" becomes a valid row and something will eventually read it as global. Granted only by the documented bootstrap; never settable through any form, API or profile field.

**Question 1 (branch overrides) — CLOSED.** Verified against both `prisma/seed.ts` and the live dev table: all `BeltRequirement` rows carry `academyId = NULL`. No per-branch override has ever existed, and no code path outside the seed has ever written one. Beyond that, per-branch thresholds are *semantically undefined* under cross-branch attendance pooling, so the mechanism is dropped rather than carried into `BeltRank`/`PromotionConfig`. The spec's instruction to preserve overrides was explicitly conditional on overrides existing; it does not apply.

**6. Enforcement is layered: a typed wrapper as the only access path, with the Prisma extension underneath as a runtime backstop** so mistakes fail closed. Raw SQL is confined to the platform module.

**Corrected in revision 23: this was never built as decided.** "The Prisma extension underneath as a runtime backstop" implied the extension protects the base client regardless of which import a caller used. It doesn't — `getScopedDb()`'s `prisma.$extends({...})` returns a separate derived client and never touches the base `prisma` singleton, which stayed a plain, unguarded `PrismaClient`. `src/app/[locale]/(staff)/layout.tsx` imported the raw client directly and queried a tenant-scoped model unscoped, and nothing caught it. The decision's OWN next paragraph — "raw delegates unexported, tenant context required as an argument" — describes the correct shape and was simply never carried out for the base client itself. See revision 23 for the finding and the fix.

Be precise about what enforces what. ESLint `no-restricted-imports` is a lint/CI restriction, **not** a TypeScript guarantee — it fails a build, it does not make the unsafe call untypeable. Design the wrapper so the types themselves make unscoped access hard: raw delegates unexported, tenant context required as an argument. Lint is the secondary net.

Neither layer proves isolation by existing. Demonstrated coverage is required: a test per operation shape — reads including `findUniqueOrThrow`/`findFirstOrThrow`, aggregates, `groupBy`, create/update/delete and bulk variants, `upsert`, nested writes and relation `connect`, transactions, raw SQL — each showing a cross-tenant attempt failing.

**This is not a mechanical replacement.** Swapping `academyScopeWhere` call sites is the easy part; preserving instructor branch restrictions, handling nested writes, and scoping the kiosk and the cron job each need individual review and their own tests. Estimate accordingly.

Separately, audit the call sites. The `academyScopeWhere` comment ("do not spread this with another literal `academyId` key — the literal silently wins") documents a hazard; it is not evidence that anyone hit it. Check whether any current call site actually has that bug and report the finding either way.

---

## Sources consulted for the kids belt preset

- https://juberajj.com/kids-ibjjf-belt-system/
- https://eastonbjj.com/brazilian-jiu-jitsu/the-ibjjf-belt-system-for-kids/

These are secondary sources. Verify degree counts against the current official IBJJF graduation rulebook, and record the source and verification date, before describing the preset as official anywhere user-facing.
