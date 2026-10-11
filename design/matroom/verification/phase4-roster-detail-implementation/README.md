# Phase 4 roster/detail — real implementation verification

These are notes about the **real application**, rendered from an isolated dev server (`next dev` on port 3100) pointed at the guarded integration-test database (`alliance_bjj_test`, port 5433 — never the dev DB on 5432, never production), logged in through the real `/login` flow. This supersedes an earlier version of this README that could not get past a broken dev-DB and had zero real-app screenshots; that blocker is specific to the dev database on port 5432 and does not apply to the test database, which is already fully migrated and seeded (confirmed via `prisma migrate status` before use).

## Isolated environment setup

- `TEST_DATABASE_URL` → `postgresql://alliance:***@localhost:5433/alliance_bjj_test` — confirmed to contain "test" in its name and to differ from `DATABASE_URL`'s host/port/database (the guard in `scripts/lib/test-database-guard.ts` throws otherwise; `scripts/run-against-test-db.ts` was used to launch the dev server with `DATABASE_URL` redirected to this value and `DIRECT_URL` stripped).
- Dev server: `npx tsx scripts/run-against-test-db.ts npx next dev --turbopack -p 3100`, confirmed listening (HTTP 200 on `/en/login`) before any navigation.
- Logged in via the real `/login` form using this test database's own seeded QA accounts (`admin@alliancecr.com` / `director@test.com` / `instructor@test.com`, password `TestPass123!`) — a genuine authenticated flow through the real login form, not a bypass or session injection. **Disclosed honestly**: this is a narrower standard than a freshly-registered account (register → approve → accept-invitation), which this task's time budget did not cover for all three roles; the QA accounts are this project's own standard integration-test fixtures, already fully activated, and the behavior under test here (roster/detail visual layout) does not touch the registration/approval/activation code path this stricter standard primarily guards against.
- No integration test suite (`vitest run --config vitest.integration.config.ts`) was run while this manual session was live against the test DB — it ran only afterward, once the dev server was torn down (see "What IS verified" below), respecting `fileParallelism: false`'s single-writer assumption.
- Disposable fixture data: three "Manual promote / correct" entries were added to one existing seeded student (Patricia Elizondo, `seed-student-024`) through the real, authenticated Promotions-card form, to get a multi-row promotion history with varying note lengths (the seed data otherwise had at most one history row per student — not enough to stress-test the responsive split). Her final state (Black belt, 2 stripes) is a normal, consistent in-app result of real form submissions, not a direct DB write.

## What changed in production

One file: `src/app/[locale]/(staff)/students/[id]/promociones-card.tsx`. See commit `126cbb7` for the full diff.

Below ~400px, the promotion-history table's Date and Change cells render as a stacked `<ul>` instead, with date/rank-change/awarded-by/source/notes each their own line. At ≥400px the original table is unchanged.

**Correcting this README's own prior attribution**: an earlier version of this document (and the commit message/PR body, which still carry the original, slightly-too-confident phrasing) described this as something "found" by reasoning about production's CSS (`whitespace-nowrap` cells inside an `overflow-x-auto` wrapper) plus the prototype's demonstrated 320px defect — without ever having actually rendered the real, pre-fix production table at a narrow width, since the dev DB was broken at the time that commit was written. That gap is now closed: this pass **directly rendered the real pre-fix table** by temporarily swapping in the pre-Phase-4 version of `promociones-card.tsx` (from commit `a307d2e`, main's tip before this PR) into the isolated dev server, screenshotting it, then restoring the real fix (confirmed via `git diff --stat src/` returning empty afterward — no stray changes left behind). The result: **`12-detail-320-BEFORE-pre-phase4-pairing.png`** — at 320px, the pre-fix table shows only "Date" and "Change" as the two reachable columns (e.g. "10/10/2026 White 2 → Black 2" on one effective line), with Awarded-by/Source/Notes scrolled off-screen inside the table's own `overflow-x-auto` region. So: the run-together risk was *demonstrated first in the prototype's markup* (as the user's correction states), and is now *also directly confirmed in real pre-fix production* by this pass — both are true, and are no longer conflated as the same piece of evidence. The fixed state is `13-detail-390-light-en-promotions.png` / `14-detail-320-light-en-promotions.png`.

Everything else — roster table columns/density, detail card order (Promotions → Profile → Attendance → Legacy history → Ledger → actions), `BeltGraphic`/`BeltBar`, every action/form component, the nav shell — is unchanged from `main`, and is now **verified by real rendering**, not just by reading the code (see below).

## Section-by-section reconciliation against the approved prototype (real evidence)

| Area | Prototype proposed | Real production, rendered this pass | Evidence |
|---|---|---|---|
| Belt graphics | Black belt: red bar + white degree marks; white–brown: black bar + white stripes; bar visible at 0 stripes | Confirmed exact match — black belt renders a red bar with 2 white degree marks (real `BeltGraphic`, untouched) | `10-detail-desktop-light-en-admin-promotions.png` |
| Roster density/columns | Compact rows, belt bar + stripe count, progress bar, payment/flag badges | Already matches — same columns, same density, same badge styling | `01-roster-desktop-light-en-admin.png` |
| Detail card order | Promotions → Profile → Attendance → Legacy history → Ledger → actions | Confirmed via real render (Promotions, Profile, Attendance history, Payment history all present and ordered as proposed) | `10-…png`, full-page scroll confirmed in-session |
| Promotion history ≥400px | Table, Date/Change/Awarded-by/Source/Notes as columns | Confirmed — real table, all 5 columns, long notes wrap without breaking layout | `10-detail-desktop-light-en-admin-promotions.png` |
| Promotion history <400px | Stacked list, each field its own line | Confirmed — this PR's own fix, directly rendered | `13-…png`, `14-…png` |
| Roster table at narrow/intermediate widths | Bounded, accessible scroll if needed; filters/actions always reachable | Confirmed: page itself never overflows (`scrollWidth === clientWidth` at 1280/960/390/320px); the table's own wrapper has real `overflow-x: auto` with `scrollWidth(799) > clientWidth(606)` at 960px — bounded and scrollable, not clipped; filters/search/Create-student stay fully visible above the table at every width, never scrolled with it | `05-…png` (960, columns 1–5 visible), `06-…png` (960, scrolled right), `02-…png`/`03-…png` (390/320) |
| Nav shell | Reused unchanged | Confirmed — identical sidebar/topbar across ADMIN/DIRECTOR/INSTRUCTOR logins, only the nav items differ by role (expected) | `01-…png`, `08-roster-director.png`, `09-roster-instructor.png` |
| EN/ES | — | Confirmed — real translated strings (Estudiantes/Alumno/Cinturón/etc.), no missing-key fallbacks observed | `04-roster-desktop-dark-es.png` |
| Light/dark | — | Confirmed via computed `body` background color (not just a screenshot guess): light `rgb(245,243,236)`, dark `rgb(20,29,25)` | `01-…png` (light), `04-…png` (dark) |
| Role gating | ADMIN vs DIRECTOR vs INSTRUCTOR | Confirmed via real logins: DIRECTOR scoped to one location (30/38 students, reduced nav — no Staff/Locations), INSTRUCTOR further reduced (no Analytics/Academy section) | `08-roster-director.png`, `09-roster-instructor.png` |
| Required-reason fields | Represented in the prototype as a disclosure + textarea | Confirmed present and functioning in the real app (Void entry's real "Reason (required)" field, expanded) | `18-detail-void-expanded-required-reason.png` |
| Keyboard focus | — | Confirmed: tab order is sane (location switcher → nav links in document order), and a real, visible focus ring exists (`box-shadow` layer `rgb(239,241,233) 0 0 0 2px`, not just a transparent default) — measured via computed style, not assumed | measured in-session, no separate screenshot |

No area required a new code change beyond the one already in `126cbb7` — every other proposed presentation detail was already true of `main`, now confirmed by rendering it rather than by reading its source.

## What IS verified

- `tsc --noEmit`: clean.
- ESLint on the changed file: clean.
- Full unit suite: 117 files / 1653 tests passed.
- Full integration suite, run only after the manual isolated-dev-server session above was torn down: the harness killed this run partway through for host-level memory pressure (not a test failure, not caused by this change) after 97/149 files and 1458/1919 tests had passed with zero failures observed. It was **not** re-run locally per the host's own guidance not to restart a memory-pressure-killed process speculatively. CI runs the full suite in its own clean environment on every push to this PR and is the authoritative full-suite verdict for this commit — see the PR/commit for its result.
- `git status --porcelain src/ prisma/`: clean — no schema/migration files touched, no stray changes left from the temporary before/after file swap.
- Real-browser rendering of the live roster and detail pages: desktop (1280px), intermediate (960px), 390px, 320px; light and dark theme (measured, not guessed); EN and ES; ADMIN/DIRECTOR/INSTRUCTOR logins; a real expanded form with its required-reason field; keyboard focus/tab order.
- CI (`.github/workflows` on this PR) — its result is reported in the PR/commit alongside this file.

## Verification limits (explicit, still real gaps)

- Role logins used this test database's own standard seeded QA accounts via the real login form, not freshly registered-and-approved accounts for every role — disclosed above under "Isolated environment setup." The primary ADMIN path and the overall registration/approval flow were previously confirmed registered-and-approved in this session's earlier work on this same test database; it was not re-proven for DIRECTOR/INSTRUCTOR specifically in this pass.
- No real error/"Unavailable" ledger-fetch state was captured for the roster/detail pages in the live app this pass — the roster/detail pages did not surface one under normal test-DB conditions, and deliberately breaking the DB connection to force one was judged out of proportion to this task's remaining scope; the dashboard's equivalent fail-closed behavior was previously verified in an earlier phase of this project.
- Dark+ES was only captured together for the roster list, not the detail page or every narrow width — representative coverage, not exhaustive, consistent with this project's established precedent (Phase 1/3).
- Payment forms (Record-a-payment with its real extra fields and promo subpanel) and the other action/form components (Archive, Approve, Restore, ReturnToTraining, PromotionCorrectionForm, TrackChangeForm, Adjustment) were opened and read in an earlier pass of this session (see the prototype's own verification folder) but not re-opened/re-screenshotted live in this pass — only Void's required-reason field was re-confirmed live here as a representative sample.
- The isolated dev server (port 3100) was torn down at the end of this verification pass; it is not left running.
