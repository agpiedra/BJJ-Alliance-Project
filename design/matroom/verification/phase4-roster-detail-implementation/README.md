# Phase 4 roster/detail — real implementation verification

These are notes about the **real application**, not the static prototype (`design/matroom/preview/phase4-roster-detail-prototype.html` and its own verification folder `design/matroom/verification/phase4-roster-detail-proposal/`). No screenshots of the real app are included in this folder — see "Blocker" below for why.

## What changed in production

One file: `src/app/[locale]/(staff)/students/[id]/promociones-card.tsx`.

The promotion-history table (`props.history.map(...)`) already rendered Date and Change as separate `<td>` cells inside an `overflow-x-auto` wrapper. The prototype's 320px pass found that pairing — a `whitespace-nowrap` Date cell beside a `whitespace-nowrap` Change cell inside a horizontally-scrolled table — reads as one run-together line at a glance, before a viewer notices there's a scrollbar. The instruction was explicit that production must not repeat this.

Fix: below 400px, the same `props.history` array now renders as a stacked `<ul>` where each entry's date, rank change, awarded-by name, source badge, and notes are separate block-level lines — same data, no new query, no behavior change. At ≥400px the original table is unchanged (`hidden` below 400px, `block` at/above it via Tailwind's `min-[400px]:` variant). This follows the same hidden/visible breakpoint-pair pattern already used elsewhere in this codebase (`platform-nav.tsx` / `platform-mobile-nav.tsx`) rather than inventing a new responsive technique.

Everything else — roster table columns/density, detail card order (Promotions → Profile → Attendance → Legacy history → Ledger → actions), `BeltGraphic`/`BeltBar`, every action/form component, the nav shell — is unchanged from current `main`. The roster's `DataTable` component (`src/components/ui/data-table.tsx`) already wraps its `<table>` in `overflow-x-auto` with no separate mobile markup, which is the same "one markup, CSS-driven reflow" shape this task required — it needed verifying, not rebuilding.

## Blocker: real-browser verification of the live pages

The local dev database (`alliance_bjj`, port 5432) is 5 migrations behind the committed schema (`20260930011315_dues_payment_exchange_rate_evidence` through `20261004120000_dues_payment_attempt` — all dated well before this session's work, confirmed via `prisma migrate status`). Loading `/students` on the dev server throws `PrismaClientKnownRequestError: The column Student.creationRequestId does not exist in the current database` — a pre-existing environment gap, unrelated to this change.

Applying those migrations would fix it, but the task's explicit scope says "No schema, migration, dev-account cleanup, activation, deployment" — so this was not done. This blocks real-browser screenshots of the live roster/detail pages at any width/theme/locale/role, and blocks exercising a real Void/Adjustment/Record-payment form in the live app for this task.

What a registered-user flow DID confirm before hitting this wall: a fresh org registers (`/register-academy`), approves (`scripts/approve-organization.ts`), and accepts its invitation (`/accept-invitation`) exactly as `feedback_verify_as_registered_user.md` requires — login as the real owner (DIRECTOR role, "Dueño") worked and reached `/dashboard`. The failure is specifically on `/students`, caused by the schema drift above, not by this change or by the login path.

## What IS verified

- `tsc --noEmit`: clean.
- ESLint on the changed file: clean.
- Full unit suite: 117 files / 1653 tests passed.
- Full integration suite (runs against the separately-migrated, fully up-to-date test database on port 5433 — unaffected by the dev-DB drift above): see commit/PR for the exact run this was captured against.
- `git status --porcelain src/ prisma/`: diff scoped to the one file above; no schema/migration files touched.
- CI (`.github/workflows` on this PR) runs against its own freshly-migrated database and is the authoritative real-environment check this change gets — its result is in the PR.

## Verification limits (explicit)

- No real-browser screenshots of the live `/students` roster or detail page exist in this folder, at any width, theme, locale, or role — blocked by the dev-DB migration gap above, not attempted around it.
- No real expanded-form screenshot (Void/Adjustment/Record-payment) in the live app for this task, for the same reason.
- Keyboard-focus traversal of the live pages was not exercised for the same reason.
- The static prototype's own verification folder (`phase4-roster-detail-proposal/`) remains the only visual evidence for the overall direction; it was built and reviewed before this implementation and is not a substitute for verifying the real pages, which this blocker prevented.
- The CI run on this PR is real-environment evidence that the change compiles, typechecks, lints, and passes the full test suite against a correctly migrated database — but CI does not take screenshots, so it does not substitute for the visual verification this README discloses as missing.
