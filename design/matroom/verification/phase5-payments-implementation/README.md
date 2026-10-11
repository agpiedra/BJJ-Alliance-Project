# Phase 5 — Payments & payment plans: production implementation

**Branch**: `feat/phase5-payments-redesign`, forked from `main` at `144e8c9` (Phase 4, merged).
**Status**: implemented, verified, held unmerged per instruction.

## Step 1 reconciliation: what actually needed to change

Read every production component the approved prototype (`design/matroom/preview/phase5-app/payments.html`,
`.../plans.html`, both v4-approved) was checked against, before writing anything:
`payments/page.tsx`, `payments-table.tsx`, `ledger-payments-table.tsx`, `payment-entry-section.tsx`,
`package-purchase-section.tsx`, `prepayment-section.tsx`, `financial-corrections-section.tsx`,
`plans/page.tsx`, `exchange-rate-section.tsx`, `awaiting-rate-receipt-section.tsx`, `exchange-rate-forms.tsx`,
`roster-ledger-status.tsx`, `list-ledger-payment-status.ts`.

**Finding, confirmed by reading the code (not assumed)**: the approved prototype's only real visual difference
from the shipped page is the three `.group-label` headings ("New ledger payments" / "Corrections" / "Debt
status") — every card, field, form, table, and role gate the prototype shows already exists, unchanged, in
production. The prototype's `.tile` label/value stacking "fix" (v4) was a defect in the **prototype's own**
shared CSS (`preview.css`'s raw `.tile` class has no `display` rule) — the real production `StatTile` component
(`src/components/ui/stat-tile.tsx:18`) already uses `flex flex-col gap-1` and has never had this bug. **No
production change was needed for the tile issue.** The Plans page's prototype (`phase5-app/plans.html`) has no
group-label headings at all, and its card structure (plan table + create-plan + dues-config nested per academy;
currency; exchange-rate; awaiting-rate receipts) already matches `plans/page.tsx` exactly — **zero changes to
Plans.**

## Exact production diff

| File | Change |
|---|---|
| `src/app/[locale]/(staff)/payments/page.tsx` | Three new `<p>` group-label headings, each real-translation-keyed and gated by the exact same conditions that already gate their card group (`canRecordPayments && ledgerActive` for "New ledger payments"; `organizationRole === "ADMIN" && ledgerActive` for "Corrections"; `ledgerActive` alone for "Debt status", since that card itself isn't role-gated). No card, form, field, or role-gate conditional was touched. |
| `messages/en.json`, `messages/es.json` | New `payments.groupLabels.{newLedgerPayments,corrections,debtStatus}` keys — the prototype's exact displayed copy, translated into Spanish, not invented. |
| `tests/integration/payments-page-ledger-render.test.ts` | 3 new tests added to the existing `"payments/page.tsx: ledger status table (page-level)"` describe block (reused its fixtures/mocks, no new test file): ADMIN sees all 3 labels in the right order relative to their cards; DIRECTOR sees "New ledger payments"/"Debt status" but not "Corrections" (ADMIN-only card); ledger-inactive (today's real production state) shows none of the three. |

**No prototype fixture data** (demo student names, demo amounts) leaked into production — every string in the
diff is either a real translation key or a conditional already present in the file.

## Reused as-is (not redesigned, confirmed by the reconciliation read above)

- `PaymentEntrySection`, `PackagePurchaseSection`, `PrepaymentSection`, `FinancialCorrectionsSection` — every
  field, required-reason input, and ADMIN/DIRECTOR role gate unchanged (`page.tsx:57,205,225,244,263`).
- `PaymentsTable` (legacy) / `LedgerPaymentsTable` (ledger-active) — the single replacement ternary
  (`page.tsx:287-301`) unchanged; the two are still never mounted together.
- `RecordPaymentForm` (legacy card) — unchanged, still gated `canRecordPayments && !ledgerActive`
  (`page.tsx:184`).
- `plans/page.tsx` and all five of its cards — byte-for-byte unchanged.
- `inactiveLedgerActivation` (`src/lib/dues/ledger/activation.ts`) — unchanged. **This is the structural reason
  real-browser verification of the three new headings was not possible** (see below) — not touched, not worked
  around.

## A structural verification limit, disclosed precisely (read before judging the evidence below)

`inactiveLedgerActivation.isActive` is a closed, production-wide singleton that returns `false`
unconditionally — by the module's own doc comment, "no activation infrastructure is built here: there is no
table, setting or flag to read yet, and none is invented," and deliberately warns against exactly the shortcut
of injecting `{ isActive: async () => true }` from a caller outside a test. This means **the three new group
labels, and every one of the four ledger-active cards they group, cannot be reached by navigating any real
browser anywhere in this codebase today** — not a gap in this round's test setup, a structural, intentional
safety seam that also governed every prior ledger-render test in this codebase (`dashboard-page-ledger-render
.test.ts`, the pre-existing `payments-page-ledger-render.test.ts`), all of which verify the ledger-active branch
the same way this round does: a real RSC render (`renderToStaticMarkup`) of the actual page component with
`inactiveLedgerActivation` swapped for a test stub via `vi.mock`, confirmed in-repo as the established pattern
before use (not invented for this round).

Confirmed via this method, against the real, unmodified `payments/page.tsx` (`tests/integration/payments-page-ledger-render.test.ts`, 3 new cases, all passing — see "Checks" below): the three group labels render in the
correct position relative to their card groups, under the correct role gates, and are absent when the ledger is
inactive (today's real state). This is real evidence from the real component, not a code-reading claim — but it
is RSC-HTML evidence, not Chromium-pixel evidence, for the ledger-active state specifically. Distinguished
explicitly from the next section, which IS real Chromium evidence.

## Real-browser verification (isolated test-DB environment, what's actually reachable)

`next dev` on port 3100, `DATABASE_URL` redirected to `TEST_DATABASE_URL` via `scripts/run-against-test-db.ts`
(guard-verified against the real dev/prod DB before use), logged in through the real `/login` form with the test
DB's seeded `admin@alliancecr.com` account. In this environment, as in real production, `ledgerActive` is false
for every organization — so what's reachable live is the **legacy** Payments page (unchanged by this PR) and the
full Plans page (unchanged by this PR). This is still meaningful evidence: it proves the unmodified parts of the
page render correctly with this PR's changes applied (no regression), using real rendering rather than
assumption.

| # | File | What it shows |
|---|---|---|
| 01 | `01-payments-desktop-admin.png` | Payments, legacy (ledger-inactive) view, 1280px, ADMIN, light, EN — matches pre-existing production exactly; no group labels, as expected when `ledgerActive=false`. |
| 02 | `02-plans-desktop-admin.png` | Plans page, 1280px, ADMIN, light, EN — unchanged by this PR, confirmed live. |
| 03 | `03-payments-320-admin.png` | Payments, 320px — full legacy form and status table still complete and reachable, no page-level overflow. |
| 04 | `04-payments-dark-es.png` | Payments, dark theme (via the real theme toggle, not a forced attribute) + Spanish locale, both live and real. |
| 05 | `05-plans-390-admin.png` | Plans, 390px, full content. |

**Measured, not eyeballed** (`document.documentElement.scrollWidth − window.innerWidth` for page-level;
`.overflow-x-auto` wrapper `scrollWidth`/`clientWidth` for table-internal, kept as two separate numbers):

| Page | Width | Page-level overflow | Table-wrap scroll×client |
|---|---|---|---|
| Payments | 960 | −15px (scrollbar only, no overflow) | — |
| Payments | 390 | −15px (no overflow) | 639×308 (bounded, deliberate) |
| Payments | 320 | −15px (no overflow) | 639×238 (bounded, deliberate) |
| Plans | 390 | −15px (no overflow) | 396×309 ×2 tables (bounded, deliberate) |
| Plans | 320 | −15px (no overflow) | measured, bounded (not separately recorded by table) |

**Keyboard focus**: real Tab traversal from a real `document.body.focus()` start, at desktop width. The new
group-label `<p>` elements carry no `tabindex` and are not natively focusable, so by construction they cannot
appear in or alter the tab sequence — confirmed structurally true, not just asserted. 10 real Tab presses moved
cleanly through the sidebar's location switcher, theme toggle, nav links, and Sign out, each stop showing a
real, non-transparent `outline: ... solid 2px` — no trap, no skipped stop, sane order.

**Light/dark, EN/ES**: capture `04` is the same live page, real theme-toggle click (not a forced `data-theme`
attribute — an earlier attempt to force the attribute directly didn't change rendered colors, confirming the
app's real toggle does more than just flip that attribute; the real button was used instead) and real Spanish
copy from `messages/es.json`.

## Selected-student package/prepayment forms — the explicit instruction to exercise them, and why it couldn't be done live

Per the same structural limit above, `PackagePurchaseSection` and `PrepaymentSection` only mount when
`ledgerActive` — unreachable in any real browser today. Exercising their selected-student state (packages,
pricing, existing debt once a student is picked) was done instead via their own existing, already-passing
component-level test suites — `tests/unit/package-purchase-section.test.tsx` and
`tests/unit/prepayment-section.test.tsx` — which were NOT written for this round (pre-existing, confirmed
unmodified) and already cover exactly this: selecting a student, the per-currency estimated total combining
existing debt with the package/prepayment price, switching between students without a stale advisory leaking
across the switch, and the pending/disabled states while a student's data is being fetched. This is React
Testing Library (jsdom) coverage, not Chromium-pixel coverage — explicitly a different, weaker form of evidence
than Phase 4's always-live-navigable precedent, disclosed here rather than glossed over as equivalent.

## Checks

- `tsc --noEmit`: clean.
- ESLint on `payments/page.tsx`: clean.
- Full unit suite: **117 files / 1658 tests passed.**
- Full integration suite: **149 files / 1922 tests passed** (1919 pre-existing + 3 new group-label tests) — no
  host memory interruption this round.
- `git status --porcelain src/ prisma/` confirmed scoped to `payments/page.tsx` only (plus the two `messages/*
  .json` files and the one test file) at every commit — no stray schema/migration/prisma changes.

## Deferred, per instruction (not touched)

- Owner-controlled promotion-policy configuration.
- Any new payment-overview/financial-reporting/growth/accounting-export section.
- Dev-DB changes, migrations, account cleanup, activation, deployment.

Hold unmerged for review.
