# Spec — Multi-Organization (SaaS) + Kids Belt System

**For:** Claude Code, working in the BJJ Alliance Project repo
**Owner:** Alexis (platform admin / product owner)
**Status:** approved for implementation, build in phases
**Revision:** 28 — Phase 7 re-scoped against what actually already existed (most of it, built continuously since Phase 1) rather than built to a stale checklist; `docs/MULTI_ACADEMY_OPERATIONS.md` written for Alexis as an operator, not an architecture summary; `docs/REDESIGN_BRIEF.md` audited and kept (implemented, cited by ~50 files, nothing to fold forward) rather than assumed stale; a launch checklist added naming every deliberately-deferred item with whether it blocks Alliance's own launch or only a future customer's. Revision 27: the timezone finding reframed and sized: not "a DST gap" but a single-timezone platform presenting itself as multi-tenant, with `Organization.timezone` a column no scheduling code reads; estimated at phase scale (core functions, context plumbing, 21 call sites, 19 test files, one real DST-edge-case design decision), not fixed yet — scheduled as a known-cost decision, not left to be discovered by a customer. Revision 26: Phase 6 billing shipped as its own PR; two bugs found only by live-browser verification (a bound-action form field silently rejected by `z.strictObject`, an off-by-one invoice deadline from a UTC/org-timezone mismatch); every `vitest.*.config.ts` now forces a deliberately hostile test-runner timezone so a test can no longer pass by agreeing with the machine it happens to run on. Revision 25: a dependency's own console output flagged, verified, and silenced as a prompt-injection surface, not because anything was actually injected that time. Revision 24: the real runtime backstop built and attached to the base client; see below for the actual blast radius this revealed. Revision 23: the Phase 1 "runtime backstop" claim corrected; it was never attached to the base client. Revision 22: the login/tenant-context conflation closed. Revision 21: repository-reviewed. Phases 1 and 2 supersede the first draft entirely; suspended-organization policy and platform billing (manual invoices, snapshotted grace, episode-scoped review) fully specified; branding moved to a first-login onboarding wizard; realistic belt rendering, student-page promotions, full sidebar palette, the attendance-by-class chart added; Phase 0 rebuilt around a clean dev database plus a deterministic seed, and the Phase 1 review decisions settled in Appendix C.

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
- **Exclude onboarding credits** (Phase 3). They are promotion-relevant but nobody attended a class, so they belong to no class and no week. Both this chart and the weekly trend exclude them, via the flag rather than a string match on the reason.
- Group by class (the schedule entry — "Lunes 6:00 GI principiantes"), not by individual session.
- Range selector shared with the trend chart where they sit on the same dashboard: last 7 / 30 / 90 days. One control, both charts.
- Organization-scoped, branch-filtered by the viewer's permitted branches. Carry the same cross-branch caption the trend chart uses ("cuenta por sede de entrada…"), since a student training at both locations appears under the class they attended.
- Sorted by count descending. Show the top 10 with a "ver todas" expansion; do not render 30 bars by default.

### Chart form

**Horizontal bars.** Class names are long ("Miércoles 6:30 competición") and vertical bars force rotated labels, which are slow to read and collide at narrow widths. Horizontal bars give every label a full readable line.

Specifics:

- **One measure across categories = one color.** A single series takes a single color — do not assign a different hue per class. Rainbow bars imply a categorical encoding that isn't there, and they break the moment the filter changes which classes survive.
- No legend for a single series; the chart title names the measure.
- 4px rounded ends on the data end only, anchored flat to the baseline. Thin bars with a 2px gap between them.
- Recessive axes and gridlines — light, thin, behind the data. Value labels at the end of each bar; no axis clutter duplicating them.
- Hover tooltip per bar: class name, count, and the count's share of the range total.
- **Dark mode is chosen, not flipped.** Pick the dark-surface bar color deliberately and check it against the dark background; do not auto-invert the light one.
- Empty state ("sin asistencias en este rango") and a loading skeleton — not a collapsed axis or a spinner over a blank box.
- Accessibility: a table view of the same data reachable from the chart, and an accessible name per bar. Identity must never rest on color alone.

### Placement

On the director dashboard, directly below the weekly trend, full width. Both charts share the range control. The instructor dashboard shows the same chart scoped to their branch.

### Acceptance criteria

- [ ] Totals in the bar chart reconcile exactly with the weekly trend over the same range and branch filter — asserted by a test using the shared aggregation, not by two independent queries.
- [ ] Changing the range control updates both charts.
- [ ] An instructor sees only their branch's classes; a director sees all branches in their organization; no class from another organization ever appears.
- [ ] A single color is used for all bars; no per-class hue assignment exists in the code.
- [ ] Filtering to fewer classes does not repaint the survivors a different color.
- [ ] Long class names render fully, unrotated and untruncated, at 1280px and at phone width.
- [ ] Hover tooltip shows class, count and share; a keyboard user can reach the same information.
- [ ] Dark mode uses its own selected bar and surface colors, verified by screenshot on the dark dashboard.
- [ ] Empty and loading states render correctly with a new organization that has no attendance yet.

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
| **No verified Resend sending domain** (`EMAIL_FROM` still points at `notifications@resend.dev`, Resend sandbox mode) | Resend's sandbox only delivers to the Resend **account's own** verified email address. Every other recipient — every real director, every real student, every real staff member — silently never receives their invitation, password reset, or digest email. This is not a future-customer problem; it breaks Alliance's own onboarding today. | **Alliance's launch.** Get a verified sending domain in Resend and update `EMAIL_FROM` before any real user needs to receive an email. |
| **No terms-of-service document** (`register-academy`'s checkbox says "I agree to the terms" and stores `termsAcceptedAt`, but nothing exists for anyone to read or link to — confirmed: no `/terms` route, no linked document anywhere) | Every organization that registers is asked to agree to terms that don't exist. This is a legal-exposure question, not a technical one — I can't size the risk, only confirm the gap is real. | **Alliance's launch, if you register Alliance itself through this flow — otherwise a decision only you can make, not a technical blocker.** Flagged here because nobody had confirmed the document didn't exist; whether that's acceptable for a v1 with one customer is a business call. |
| **Single-timezone platform** (`ZONE = "America/Costa_Rica"` hardcoded in scheduling/attendance/the weekly digest; see revision 27's own entry for the full breakdown and size estimate) | An organization outside `America/Costa_Rica` gets silently wrong attendance dates, check-in windows, and digest windows — not a DST-only issue, wrong from day one for that org. | **Only the second customer** — Alliance is UTC-6, so this cannot manifest for Alliance itself. Sized already (phase-scale, ~a week) so it's a scheduled decision once a non-Costa-Rica organization is close to signing, not a scramble. |
| **DST specifically** (a subset of the above — even a UTC-6-hardcoded org's own billing math has never been exercised across a real DST transition) | Same root cause as above; billing's `deadline.ts` already reads `Organization.timezone` correctly and should handle it by construction, but that specific case has no test proving it. | **Only the second customer**, and only one in a DST-observing zone. Costa Rica itself never observes DST, so Alliance can never trigger this. |
| **Impersonation not built** (Phase 6's own open question — a platform admin "opening as" an organization) | No support workflow lets you see the app exactly as a confused director sees it without asking them to screen-share. | **Neither**, today. You're the only platform admin and Alliance is your only organization — there's no scenario yet where you need to act inside an account that isn't reachable some other way. Revisit if support load or customer count grows enough to need it. |
| **No director-facing audit view** (Phase 6's own known-future-need note — only the platform admin's own panel can read `AuditLog`) | A director asking "who changed this student's belt?" has no page to answer it; only you can look it up via `/platform`. | **Neither**, today, for the same reason as impersonation — you're reachable for that question right now. Becomes real the day a director expects to self-serve it. |
| **Real icon/logo artwork** (`src/app/icon.png` etc. are a neutral "P" monogram placeholder, not real brand identity) | Every organization's installed PWA icon and browser tab shows a generic placeholder, not a real mark. Cosmetic, not functional. | **Neither**, strictly — but visible to Alliance's own staff every day once real product use starts. Worth doing before it's `Alliance`'s own daily experience, not before launch specifically. |
| **The product itself has no chosen name** (`PLATFORM_NAME` in `src/lib/platform.ts` is a placeholder; the browser tab and pre-tenant pages literally read "[Platform name TBD]" today, confirmed live) | Same category as the icon — looks unfinished on every page that has no organization to name yet (login, the marketing home, the browser tab). | **Neither**, strictly, but same reasoning as the icon: it's Alliance's own staff who see this daily. One-line fix once a name exists (`src/lib/platform.ts`'s own comment: "the entire update once it is"). |
| **`E2E_AUTH_BYPASS_SECRET` / the e2e-auth-bypass route** | If this were ever set in a real production environment, it mints a real session for any user id a caller names. | **Neither, already defended at the code level**, not just by convention: the route itself refuses to work when `NODE_ENV === "production"`, regardless of whether the secret is set. The one operational step that matters: never set `E2E_AUTH_BYPASS_SECRET` as a Production environment variable on your host. Worth one manual check at deploy time, not a build task. |
| **Per-organization student limits / plan tiers, custom rank tracks, per-organization data export** (Appendix B's own open questions — longer-standing than this week's revisions) | Different in kind from everything above: these are product-scope questions Alexis herself flagged, not implementation gaps found during a build. | Not sized here — see Appendix B directly; these were never claimed to be resolved. |

**Read together:** exactly one item above (the Resend sending domain) blocks Alliance's own
launch outright. One (terms of service) is a business decision this doc can surface but not
make for you. Everything else either cannot affect Alliance at all (single-timezone/DST, given
Alliance's own zone) or is cosmetic/support tooling that matters once there's more than one
organization or more support load than you can personally absorb.

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
