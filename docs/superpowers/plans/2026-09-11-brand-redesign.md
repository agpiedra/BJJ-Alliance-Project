# Alliance Brand Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Alliance Jiu-Jitsu's real black/white/gold brand identity across the whole app —
a redefined color/typography token system, a persistent sidebar shell for staff-facing pages, a
branded banner treatment for public-facing pages, and a real public home page — with zero changes
to any business logic, data-fetching, or server action anywhere in the app. This is a pure
presentation-layer redesign of an already-built, already-reviewed application.

**Architecture:** The app already uses a full shadcn/ui CSS-variable token system
(`src/app/globals.css`, `:root`/`.dark`, currently pure grayscale) and has **zero** hardcoded
Tailwind gray/slate/zinc classes anywhere in the codebase — every page already reads color through
semantic tokens (`bg-primary`, `text-muted-foreground`, etc.). This means redefining the token
*values* in one file cascades the new palette across nearly the whole app with no per-page color
edits needed. The remaining work is structural: a new persistent sidebar for staff routes (via
Next.js route groups, which change file location but never the URL), a lightweight banner
component for public routes, real font loading (currently unset), and one net-new page (the public
home page, currently a bare placeholder stub).

**Tech Stack:** Next.js 15 App Router, Tailwind v4 (CSS-variable theming, already in place),
shadcn/ui (already the component library in use — `Button`/`Card`/`Badge` exist; this plan adds
the official `sidebar` block), `next/font` (net new — no font is currently loaded despite
`--font-sans`/`--font-geist-mono` tokens already being referenced in `globals.css`), `sharp`
(already an installed transitive dependency, usable for icon generation), next-intl.

**Spec:** No `PROJECT_SPEC.md` section governs this — it is a pure visual/branding redesign, not a
new phase from the spec's build order. The one relevant spec constraint is §10's mobile-first
quality bar, which applies to every page this plan touches.

**Brand assets:** `public/branding/logo.png` (282×252 PNG, RGBA but effectively opaque white
background, not transparent — every use of this logo must sit inside a light plaque/circle
backdrop, never assume it will blend into a dark background on its own).

## Global Constraints

- **This is a presentation-layer-only redesign.** No task in this plan may modify a server
  action's logic, a Prisma query's shape, a validation rule, an authorization check, or any
  `src/lib/**` business-logic file's behavior. If a task's own review finds a business-logic
  change (not just its surrounding JSX/className), that is a scope violation to be rejected, not
  approved with a note.
- **Ruling: color token architecture.** Redefine `globals.css`'s existing tokens
  (`--background`, `--foreground`, `--primary`, `--card`, `--border`, `--sidebar-*`, etc.) to a
  neutral near-black/off-white pairing — reusing the SAME neutral (zero-chroma) scale already
  present, just anchored differently, so every existing `bg-primary`/`text-foreground`/etc. usage
  across all 8 already-built phases stays visually coherent without needing per-component edits.
  **Do NOT make `--primary` gold.** Gold-on-white at small text sizes routinely fails WCAG AA
  (4.5:1), and `--primary` currently backs dozens of already-reviewed buttons across every phase
  (confirm-promotion, record-payment, export-CSV, etc.) — recoloring it risks a real,
  hard-to-fully-audit contrast regression across the whole app. Instead, add TWO NEW dedicated
  tokens: `--brand-gold` and `--brand-gold-foreground` (the text/icon color to use ON a gold
  background), consumed only by the specific new brand elements this plan introduces (sidebar
  active-nav-item highlight, banner/logo plaque accents, home page stat highlights) — never by
  existing generic buttons. Reasonable starting values (implementer should verify actual contrast
  with a real checker, not just eyeball it): `--brand-gold: oklch(0.82 0.17 85)` (a warm,
  saturated gold in the Tailwind amber-400/500 range), `--brand-gold-foreground: oklch(0.145 0 0)`
  (near-black text on gold, which passes contrast far more reliably than white-on-gold).
- **Ruling: no dark-mode toggle.** The `.dark` CSS block already exists (shadcn boilerplate) but
  nothing in the app currently toggles it (no `next-themes`, no theme switcher UI) — the app is
  effectively light-mode-only today. Redefine the `.dark` block's values to a sensible dark
  equivalent of the new palette (cheap, since the structure already exists) but do NOT add a
  toggle UI or wire up `prefers-color-scheme` — that's a new feature, not part of this redesign,
  and nothing in this app currently exercises the `.dark` class path.
- **Ruling: `next/font` with Geist.** Load Geist Sans and Geist Mono via `next/font/google` (or
  `next/font/local` if the project prefers vendoring — implementer's call, document it), wired to
  the ALREADY-REFERENCED `--font-sans`/`--font-geist-mono` CSS variable names in `globals.css` (do
  not invent new variable names — the token plumbing already expects these exact names). Add the
  font-loading call in `src/app/[locale]/layout.tsx` (the real HTML-rendering layout — confirmed
  in this session that `src/app/layout.tsx` is a pass-through, not where `<html>`/`<body>` render).
- **Ruling: staff sidebar via Next.js route groups, not a new URL prefix.** Move
  `src/app/[locale]/dashboard/`, `src/app/[locale]/students/`, and `src/app/[locale]/admin/` in
  their entirety into a new `src/app/[locale]/(staff)/` route group directory (parenthesized
  segments are excluded from the URL by Next.js's own routing convention — `/dashboard` stays
  `/dashboard`, `/students/[id]` stays `/students/[id]`, etc.). This is a `git mv` of whole
  directory subtrees, not a rewrite — every file inside keeps its relative imports intact.
  **Exactly two files in the whole codebase import these pages by absolute `@/app/[locale]/...`
  path and need their import path updated** (confirmed via repo-wide grep before this plan was
  written): `tests/unit/dashboard-promotion-queue-i18n.test.tsx` and
  `tests/unit/record-payment-form.test.tsx`. Grep again before treating this as exhaustive — a
  worker's own environment may have drifted since this plan was written.
- **Ruling: `/portal` and `/kiosk/[academySlug]` do NOT get the staff sidebar.** `/portal` is a
  single simple student-authenticated page; `/kiosk/[academySlug]` is a touch-optimized public
  terminal UI. Both get the lightweight banner treatment (Task 3), not the persistent sidebar
  shell (Task 2) — a sidebar would be genuine UX regression on a kiosk tablet and unnecessary
  chrome on the student portal's one page.
- **Ruling: the kiosk banner must stay compact.** `/kiosk/[academySlug]` is used on a tablet for
  fast check-ins — the banner must not push the check-in code entry below the fold on a typical
  tablet viewport (assume ~768px height as the floor to design against). A small single-line
  logo-plus-academy-name strip, not a tall decorative banner.
- **Ruling: the public home page (`/`) is the one task with genuinely new content, not just a
  reskin.** It is currently a bare two-line placeholder stub (`heading`/`subheading` only, from
  Phase 1 scaffolding, never built out). Task 4 replaces it with a real informational landing page
  in the new brand language — reusing the reference screenshot's visual RHYTHM (a headline, a
  small real-data stats row, a compact weekly-schedule preview, a belt-progression showcase) with
  this school's actual copy voice and actual data, not the screenshot's literal placeholder
  content. This is explicitly NOT a sales/marketing page with pricing or unrelated promotional
  content — it is a public overview of the school with a path to `/signup` and `/login`.
- **Existing role-gating and access patterns are copied, never re-derived.** The sidebar's nav
  link visibility for Analytics/Schedule-admin/Kiosk-tokens-admin must reuse each target page's
  OWN already-established visibility rule (e.g., the same session-role check each page/dashboard
  link already uses today) — never invent a new, second definition of "who can see this link."
- **Status colors keep their semantic meaning.** The ~17 files using hardcoded
  green/red/amber/blue Tailwind classes for status semantics (active/inactive, overdue,
  eligible, etc.) are a deliberate exception to the "everything flows from CSS tokens" rule
  established elsewhere in this codebase — leave their semantic role intact (success stays a
  green family, danger/overdue stays a red family), only adjust exact shades if a specific one
  reads poorly against the new palette. Never let a status color drift into the same hue as
  `--brand-gold` — a warning/pending state rendered in brand-gold would visually collide with
  "this is the brand accent," not "this needs attention."
- **Favicon/manifest cleanup.** `public/manifest.json` and the app's favicon are still Next.js's
  default starter-template values (generic favicon, Next.js default `theme_color`). Replace with
  real Alliance branding as part of Task 1. `public/file.svg`, `globe.svg`, `next.svg`,
  `vercel.svg`, `window.svg` are Next.js starter-template leftovers — confirm each is genuinely
  unreferenced (`grep -rl` its filename across `src/`) before deleting; delete only the confirmed-
  unused ones.
- **Feature-branch-only.** Push to `feat/brand-redesign`, never `main`. One PR opens at the end
  for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys occasionally injected into
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this
  work — revert just those lines if `git status`/`git diff` shows them before committing.
- **`pnpm db:down && pnpm db:up` does NOT reset the local Postgres data** — a genuine reset is
  `docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
  `pnpm exec prisma generate`, `pnpm db:seed`. This plan makes no schema changes, so no migration
  is expected — if `pnpm db:migrate` ever reports a pending migration, something has gone wrong.
- **A known, pre-existing, unrelated test-infrastructure issue**: `tests/integration/seed.test.ts`
  can fail under certain parallelism/leftover-fixture conditions — documented since Phase 6/7, not
  this work's to fix. If hit, use `npx vitest run tests/integration --no-file-parallelism` for
  your own verification and note it rather than treating it as a regression.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!skills-lock.json'`
  (untracked, pre-existing, not this project's files).

---

### Task 1: Design tokens, fonts, and brand assets

**Files:**
- Modify: `src/app/globals.css`, `src/app/[locale]/layout.tsx`, `public/manifest.json`
- Create: `src/app/icon.png` (or `.ico` — Next.js App Router auto-wires favicon from a file
  literally named `icon`/`favicon` under `src/app/`; check current Next.js 15.5 convention before
  picking the exact filename/format), `src/components/brand/logo-mark.tsx`,
  `src/components/brand/brand-banner.tsx`
- Delete (only if confirmed unreferenced): `public/file.svg`, `public/globe.svg`,
  `public/next.svg`, `public/vercel.svg`, `public/window.svg`

**Interfaces:**
- Produces:
  - New CSS custom properties in `globals.css`: `--brand-gold`, `--brand-gold-foreground` (both
    `:root` and `.dark`), plus redefined values (not new names) for the existing
    `--background`/`--foreground`/`--primary`/`--card`/`--border`/`--sidebar-*`/etc. tokens.
  - `function LogoMark(props: { size?: number; className?: string }): JSX.Element` — renders
    `public/branding/logo.png` via `next/image` inside a light plaque/circle backdrop (compensating
    for the logo's opaque white background), reusable at multiple sizes.
  - `function BrandBanner(props: { children?: React.ReactNode; compact?: boolean }): JSX.Element`
    — a horizontal banner bar (near-black background) containing `LogoMark` plus optional slot
    content (e.g., a page title or nav trigger). `compact` renders the single-line kiosk-appropriate
    variant (this plan's kiosk ruling above).

- [ ] **Step 1: Verify the logo asset and inspect its actual dimensions/transparency**

```bash
node -e "
const fs = require('fs');
const buf = fs.readFileSync('public/branding/logo.png');
console.log('PNG signature ok:', buf[0] === 0x89 && buf[1] === 0x50);
"
file public/branding/logo.png
```

Confirm it's a valid PNG before building components around it. If you have access to `sharp`
(installed transitively — resolve it via `node -e "require(require.resolve('sharp', { paths: [process.cwd()] }))"`
or by adding it as a direct devDependency temporarily if resolution fails from the repo root), use
it to check whether the alpha channel has any real transparency (min/max alpha across sampled
pixels) — this determines whether `LogoMark`'s plaque backdrop is strictly required or just a
safe default. Either way, ship the plaque backdrop; do not skip it on an assumption.

- [ ] **Step 2: Redefine the color tokens**

In `globals.css`, redefine (not rename) `:root`'s existing near-white/near-black neutral scale so
`--background`/`--card`/`--popover` land on a clean off-white and `--foreground`/`--primary` land
on a true near-black (the app's existing zero-chroma neutral scale already supports this — you are
moving where on that scale each token points, not introducing new hues for these particular
tokens). Add `--brand-gold`/`--brand-gold-foreground` as NEW tokens (both `:root` and `.dark`) per
this plan's ruling above — do not let any generic component token (`--primary`, `--accent`,
`--secondary`) become gold. Also redefine the `--sidebar-*` token family (`--sidebar`,
`--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, etc.) to the near-black scale,
since these back the new sidebar shell (Task 2) and should read as a distinct, darker panel
against the off-white main content area — reference `--brand-gold` for `--sidebar-primary` (the
active-nav-item highlight color) specifically, since that IS one of the sanctioned gold-accent
use cases from this plan's ruling.

Update `.dark`'s block to a coherent dark-mode equivalent of the same palette (per this plan's
"no toggle, but keep the block coherent" ruling) — do not leave it as unrelated leftover grayscale
values that would look broken if `.dark` were ever toggled on by a future feature.

Verify contrast values (a plain calculation is fine — WCAG formula or an online contrast checker
run manually, cite the ratios in your report) for: gold-foreground text on gold background (must
hit at least 4.5:1 for the sizes you'll actually use it at, per Section 4.5's "button contrast"
discipline this app already generally follows), and near-black text on the new off-white
background.

- [ ] **Step 3: Load Geist via `next/font`**

In `src/app/[locale]/layout.tsx`, import Geist Sans and Geist Mono (via `next/font/google` —
verify Geist is actually available from Google Fonts under that exact name in this Next.js
version; if not, use `next/font/local` with self-hosted Geist files, or substitute a comparably
clean, neutral grotesk sans that IS available via `next/font/google`, and say which you picked and
why). Apply the resulting CSS variable class names to the `<html>` or `<body>` element so they
populate the ALREADY-REFERENCED `--font-sans`/`--font-geist-mono` custom properties in
`globals.css`'s `@theme inline` block — do not invent new variable names, the token plumbing
already expects these exact ones.

Run: `pnpm build` and visually confirm (via a running dev server, one page is enough at this step)
that body text actually renders in the new font, not a fallback.

- [ ] **Step 4: Build `LogoMark` and `BrandBanner`**

`LogoMark`: a light circular or rounded-square plaque (e.g. `bg-white` or a very light neutral,
NOT `bg-background` if `--background` is now near-white anyway that's fine, but be explicit that
this plaque must stay light regardless of what theme token is active, since the logo's own
background is fixed-white) containing the logo image via `next/image` with an explicit `alt` (the
school's real name, not "logo"), sized via the `size` prop.

`BrandBanner`: a near-black (`bg-sidebar` or a dedicated banner background token — your call,
document it) horizontal bar, `LogoMark` on the left, an optional `children` slot for page-specific
content (a title, a locale switcher, whatever a given page needs), and a `compact` variant that's
visibly shorter (single-line height) for the kiosk use case. Both must be Server Components unless
they need interactivity (they should not, at this layer — page-specific interactive content goes
in `children`).

- [ ] **Step 5: Favicon and manifest**

Add `src/app/icon.png` (or the correct current-Next.js-15.5 filename/format for App-Router
auto-favicon — check `next build`'s output or Next's own docs comments if unsure) derived from
`public/branding/logo.png`, appropriately sized/cropped for a favicon (a square crop centered on
the eagle mark, not the whole rectangular lockup with text, is almost certainly more legible at
16x16/32x32 — use `sharp` to crop/resize if available, or note in your report if you had to do
this by hand some other way). Update `public/manifest.json`'s `theme_color`/`background_color` to
the new near-black/off-white values and point its `icons` array at real, appropriately-sized
derived assets (not the raw 282×252 rectangular logo).

- [ ] **Step 6: Confirm and clean up unused starter SVGs**

```bash
for f in file globe next vercel window; do
  echo "=== $f.svg ==="
  grep -rl "$f.svg" src/ public/manifest.json 2>/dev/null
done
```

Delete only the ones with zero real references (a self-reference from `public/manifest.json`'s own
icon list, if you changed it in Step 5, doesn't count as "used" — check `src/`).

- [ ] **Step 7: Verify, commit**

Run: `pnpm build`, `pnpm test`, `npx tsc --noEmit`, `pnpm lint` — all pass/succeed (this task
touches no test-covered logic, so the existing suite should be entirely unaffected; if anything
fails, that's a real regression to fix before committing, not a pre-existing issue to wave off).

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: redefine brand color tokens, load Geist, add logo/banner components"
git push origin feat/brand-redesign
```

---

### Task 2: Staff sidebar shell

**Files:**
- Move (whole directories, `git mv`): `src/app/[locale]/dashboard/` →
  `src/app/[locale]/(staff)/dashboard/`, `src/app/[locale]/students/` →
  `src/app/[locale]/(staff)/students/`, `src/app/[locale]/admin/` →
  `src/app/[locale]/(staff)/admin/`
- Create: `src/app/[locale]/(staff)/layout.tsx`, `src/components/staff-sidebar/staff-sidebar.tsx`,
  `src/components/staff-sidebar/nav-items.ts` (or similar — a small data structure describing the
  nav links and which role(s) can see each), shadcn sidebar primitives via
  `npx shadcn@latest add sidebar` (this pulls in several files under `src/components/ui/` —
  `sidebar.tsx` plus its dependencies, likely `sheet.tsx`, `tooltip.tsx`, `separator.tsx`,
  `skeleton.tsx`, `input.tsx` if not already present — check what the install actually adds and
  list it in your report)
- Modify: `src/app/[locale]/(staff)/dashboard/page.tsx`,
  `src/app/[locale]/(staff)/dashboard/analytics/page.tsx`,
  `src/app/[locale]/(staff)/students/page.tsx`, `src/app/[locale]/(staff)/students/[id]/page.tsx`,
  `src/app/[locale]/(staff)/admin/schedule/page.tsx`,
  `src/app/[locale]/(staff)/admin/kiosk-tokens/page.tsx` (remove now-redundant inline header
  content that the shell now provides — nav links like "Ver analítica"/"Volver al panel", the
  "Bienvenido, {email}" line — leave every OTHER part of each page, especially all data-fetching
  and business logic, completely untouched),
  `tests/unit/dashboard-promotion-queue-i18n.test.tsx`, `tests/unit/record-payment-form.test.tsx`
  (update their import paths for the moved files — re-grep for any other absolute-path importers
  before assuming these two are the only ones), `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `LogoMark`/`BrandBanner`-adjacent styling primitives (Task 1), `requireStaffSession`
  (`src/lib/auth/session.ts`) for resolving the current session's role (needed to decide which
  nav links render), the existing `NotificationBell` component (Phase 8,
  `src/app/[locale]/dashboard/notification-actions.ts`/`notification-bell.tsx` — these move into
  `(staff)/dashboard/` as part of this task's directory move, and the sidebar shell renders the
  bell in its persistent header rather than each page rendering it inline).
- Produces: `interface StaffNavItem { href: string; labelKey: string; icon: <icon-component>;
  visible: (session: StaffSession) => boolean }`, a `NAV_ITEMS: StaffNavItem[]` array, and the
  `(staff)/layout.tsx` Server Component that resolves the session once, renders `StaffSidebar`
  (passing resolved nav visibility), and renders `{children}` for the actual page content.

- [ ] **Step 1: Install the shadcn sidebar block**

```bash
npx shadcn@latest add sidebar
```

Run `pnpm build` immediately after to confirm the install didn't break anything, before touching
any application code.

- [ ] **Step 2: Move the three directory subtrees**

```bash
git mv src/app/\[locale\]/dashboard src/app/\[locale\]/\(staff\)/dashboard
git mv src/app/\[locale\]/students src/app/\[locale\]/\(staff\)/students
git mv src/app/\[locale\]/admin src/app/\[locale\]/\(staff\)/admin
```

(Adjust shell-escaping for whatever shell you're actually running in — the bracket/paren
characters need quoting either way.) Run `pnpm build` and the full test suite immediately after
this step, BEFORE writing any new code — this step should be a pure, behavior-neutral file move.
If anything breaks here, fix the import-path fallout (the two files this plan's Global Constraints
named, plus any others a fresh grep turns up) before proceeding to Step 3.

- [ ] **Step 3: Write `NAV_ITEMS` and the visibility rules**

For each nav item, find and reuse the EXACT existing visibility check each target page/link
already uses today (e.g., however the current dashboard decides whether to show a
"Ver analítica"/"Horario de clases"/"Tokens de kiosco" link — read those pages' current source
before writing this, the checks already exist, do not invent new ones). Write a focused unit test
for `NAV_ITEMS`'s visibility functions covering ADMIN (sees everything), DIRECTOR (sees dashboard +
students + analytics, not the two ADMIN-only admin links), INSTRUCTOR (sees dashboard + students
only).

- [ ] **Step 4: Build `StaffSidebar` and `(staff)/layout.tsx`**

`(staff)/layout.tsx`: resolves the session (redirect-to-login behavior should already be handled
by whatever each page's own `requireStaffSession` call does — do not duplicate or fight that;
this layout's OWN session read is just for deciding nav visibility, not for enforcing access,
since access enforcement must stay exactly where it already is, in each page/action itself, per
this app's established "never rely on hiding UI elements, self-enforce server-side" discipline
from every prior phase), renders `StaffSidebar` with the resolved nav item visibility, includes
the `NotificationBell` in the sidebar's persistent header/footer area, and renders `{children}`.

`StaffSidebar`: uses the installed shadcn `Sidebar`/`SidebarProvider`/`SidebarTrigger`/etc.
primitives (do not hand-roll a sidebar from scratch now that the official block is installed —
that would be the "recreate a design system's CSS by hand" anti-pattern), styled via the new
`--sidebar-*` tokens from Task 1 (which should require zero additional per-component color
overrides if Task 1 wired them correctly — if you find yourself hardcoding a color here, that's a
sign Task 1's token wiring needs revisiting, flag it rather than overriding locally), with
`LogoMark` in its header area functioning as the banner/brand lockup this plan calls for.
Collapsible on mobile (the shadcn sidebar block supports this out of the box via a sheet/drawer on
narrow viewports — confirm this actually works at a phone-width viewport before considering this
step done, per this app's established mobile-first quality bar).

- [ ] **Step 5: Trim each moved page's now-redundant inline header content**

For each of the 6 moved pages, remove ONLY the header content that duplicates what the sidebar
shell now provides (nav links between staff pages, the generic "Bienvenido, {email}" welcome
line if it's purely decorative chrome and not load-bearing for anything). Do NOT touch anything
below that — the promotion queue, the payments-overdue panel, the student roster table, the
schedule editor, the kiosk-token list, the analytics panels are all untouched by this task.

- [ ] **Step 6: Add/update message keys, verify, commit**

Run: `pnpm test` (full suite — this step moved and edited real page files, so run everything, not
just a spot check), `pnpm build`, `npx tsc --noEmit`, `pnpm lint`. Manually verify in a running dev
server, for at least one ADMIN and one INSTRUCTOR session, that: the sidebar renders with correct
nav visibility per role, every moved page's URL is unchanged (`/dashboard`, `/students`,
`/students/[id]`, `/admin/schedule`, `/admin/kiosk-tokens`, `/dashboard/analytics` all still
resolve), and the mobile sidebar collapse actually works.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add persistent staff sidebar shell via route group"
git push origin feat/brand-redesign
```

---

### Task 3: Public-facing pages banner + palette

**Files:**
- Modify: `src/app/[locale]/login/page.tsx`, `src/app/[locale]/signup/page.tsx`,
  `src/app/[locale]/forgot-password/page.tsx`, `src/app/[locale]/reset-password/page.tsx`,
  `src/app/[locale]/portal/page.tsx`, `src/app/[locale]/kiosk/[academySlug]/page.tsx`,
  `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `BrandBanner` (Task 1, `compact` variant for the kiosk page specifically per this
  plan's ruling).

- [ ] **Step 1: Add `BrandBanner` to each of the 6 pages**

For login/signup/forgot-password/reset-password/portal: the default (non-compact) `BrandBanner`
above each page's existing content, no other structural changes — these pages' actual forms/logic
are untouched, this is additive header content plus whatever palette changes cascade automatically
from Task 1's token redefinition.

For `kiosk/[academySlug]`: the `compact` variant specifically, verified (per this plan's ruling)
to not push the check-in code-entry UI below the fold at a representative tablet viewport
(~768px tall) — actually resize a browser to check this, don't just assume.

- [ ] **Step 2: Visual pass on each page**

Since color now cascades from Task 1's tokens automatically, this step is about catching anything
that DOESN'T look right with the new palette/banner combination — spacing that assumed the old
bare-header layout, a status color that now reads poorly, etc. Fix what you find; this is a
judgment step, not a mechanical one.

- [ ] **Step 3: Verify, commit**

Run: `pnpm test`, `pnpm build`, `npx tsc --noEmit`, `pnpm lint`.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add brand banner to public-facing pages"
git push origin feat/brand-redesign
```

---

### Task 4: Public home page rebuild

**Files:**
- Modify: `src/app/[locale]/page.tsx`, `messages/es.json`, `messages/en.json`
- Create: any small server-only data-fetching helper this page needs (e.g., a simple
  `getPublicHomeStats()` reading `prisma.academy.count()`/`prisma.classSession.count()` — keep
  this genuinely simple, a page-local file is fine, this does not need to become a shared `src/lib`
  module unless a later task turns out to need the same numbers)

**Interfaces:**
- Consumes: `BrandBanner`/`LogoMark` (Task 1), `prisma` (`src/lib/prisma.ts`) for the real stats
  row — this is PUBLIC, unauthenticated data (academy count, weekly class count), not
  student/staff-sensitive information, so no session/role gating is needed on this query, but
  confirm you are not accidentally exposing anything beyond simple aggregate counts (no student
  names, no financial figures, nothing per-person).

- [ ] **Step 1: Replace the placeholder stub with a real landing page**

Structure (reusing the reference screenshot's RHYTHM, not its literal copy): a headline + short
subtext in the new brand language, a small real-data stats row (academies, weekly classes,
timezone — genuinely simple `count()` queries, no elaborate aggregation), a compact preview of
one academy's weekly schedule (reuse whatever existing schedule-query pattern already exists for
the admin schedule page rather than inventing a new one, since this is the exact same
`ClassSession` data, just presented read-only and publicly), and a belt-progression showcase row
(the existing `BeltGraphic` component, if one already exists from an earlier phase — check
`src/components/belt-graphic/` before building a new belt-rendering approach). End with a CTA
toward `/signup` and a link to `/login` for existing students/staff. Genuinely new copy in Spanish
(default locale) and English, written for this school specifically — not the screenshot's literal
placeholder text.

This is a Server Component (no interactivity needed for a static informational page).

- [ ] **Step 2: Add message keys, verify, commit**

Run: `pnpm test`, `pnpm build`, `npx tsc --noEmit`, `pnpm lint`.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: build real public home page with brand identity"
git push origin feat/brand-redesign
```

---

### Task 5: Status-color harmonization and full-suite verification

**Files:** the ~17 files using hardcoded status colors (enumerate them fresh via
`grep -rl "text-green-\|bg-green-\|text-red-\|bg-red-\|text-yellow-\|bg-yellow-\|text-amber-\|bg-amber-\|text-blue-\|bg-blue-" src/app src/components`
— do not trust this plan's count as exact, re-derive it), no other files.

- [ ] **Step 1: Review each status-color usage against the new palette**

For each match, confirm: it still reads clearly against the new off-white background/near-black
sidebar, it doesn't share a hue family with `--brand-gold` (this plan's ruling — a warning/pending
state must not look like "this is a brand accent"), and its semantic meaning (success/danger/
warning/info) is unchanged. Adjust the specific Tailwind shade (e.g. `amber-500` → a slightly
different amber, or swap a warning color's hue entirely if it's currently too close to
`--brand-gold`) only where genuinely needed — most of these are probably already fine and need no
change; do not edit ones that already look correct just to "touch everything."

- [ ] **Step 2: Full-suite verification**

```bash
pnpm db:migrate
pnpm exec prisma generate
pnpm test
pnpm build
pnpm lint
npx tsc --noEmit
```

No migration is expected (confirm `pnpm db:migrate` reports nothing pending). All tests should
pass unchanged — this entire plan touches no business logic, so a test failure here is a real
regression to investigate, not a known pre-existing issue, EXCEPT the one documented
`seed.test.ts` flake named in this plan's Global Constraints.

- [ ] **Step 3: Manual end-to-end visual walk**

In a live browser (or via Playwright), walk through: the public home page, login, signup, the
kiosk compact banner at a tablet-height viewport, the portal page, and the staff sidebar shell as
both an ADMIN and an INSTRUCTOR session (confirming nav visibility differs correctly per role and
matches Task 2's own test coverage), at both desktop and phone widths (per this app's mobile-first
quality bar). Take screenshots of at least: the public home page, the staff dashboard with sidebar,
and the mobile-collapsed sidebar. Confirm no layout breaks, no illegible text against the new
palette, no CTA button with contrast issues.

- [ ] **Step 4: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "fix: status-color harmonization; full-suite verification for brand redesign"
git push origin feat/brand-redesign
```

This plan is complete once this task's full-suite verification and manual walk both pass. This
plan's controller will dispatch a final whole-branch review before opening a PR — do not open the
PR yourself.
