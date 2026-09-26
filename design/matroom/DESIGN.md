# MATROOM design authority

**Status:** the visual authority for MATROOM (the platform) and for the shared design system every tenant experience is built on. Established in the Phase 1 foundation PR, 2026-09-24. It supersedes the visual direction of `docs/REDESIGN_BRIEF.md` and `design/alliance-mock.html` (gold and near-black, Alliance-branded) wherever they conflict; their functional requirements are unaffected. Both files carry a superseded note pointing here.

**Where things live**

| What | Where |
|---|---|
| Colour, radius, default brand (the values) | `design/matroom/tokens.css`, imported by `src/app/globals.css` |
| Enforcement | `tests/unit/design-tokens.test.ts` (every pair, both themes), `tests/unit/tenant-presentation.test.ts`, `tests/unit/branding-scope.test.tsx`, `tests/unit/controls.test.tsx` |
| The approved references (read-only copies, SHA-256 in `MANIFEST.md`) | `design/matroom/reference/` |
| The approved Phase 1 preview (frozen; fonts included so it opens offline) | `design/matroom/preview/index.html` |
| The proposal that recorded decisions D1-D8 (corrected copy) | `design/matroom/proposal/` |
| The contrast audit of the preview | `design/matroom/preview/contrast-report.md` |

The references are **prototypes**, not production code or data. Prototype names, ranks, schedules and counts are illustrative and are never used as content.

## 1. Decisions

Decisions D1-D8 come from the proposal. The owner approved the Phase 1 items on 2026-09-24.

| | Decision | Status |
|---|---|---|
| D1 | Tenant colours coexist with MATROOM by **Option B**: today's mechanism (`BrandingScope`) kept, MATROOM forest is the default, platform-owned pages are always MATROOM. | Approved and implemented. See "Tenant branding" for the one thing that does not yet hold (new-organization defaults). |
| D2 | Editorial serif for Persuade surfaces (landing, registration, platform sign-in): the **Georgia stack** for now, no vendored file. | Approved for now. **Gate:** the fallback on Android (and Linux) is verified on a real device or emulator before the landing page is finalized; if it does not hold, a vendored open serif is specimen-tested first. |
| D3 | IBM Plex Sans alone for Operate surfaces (portal, dashboard, kiosk), semibold headings, IBM Plex Mono for codes, times and counts. Archivo is retired. | Approved and implemented. |
| D4 | Dark theme for the app screens uses the landing's dark palette as the starting point; both themes are first-class. | Approved and implemented (additions below). |
| D5 | Control boundary token `--input`: `#738b79` light, `#6d8a76` dark, at least 3:1 on ground, card and soft fill. | Approved and implemented. (The proposal first said `#7f9084`; that was checked on two of three surfaces and is superseded.) |
| D6 | Phone navigation: top bar, menu button and sheet for student and staff, no bottom navigation, two new strings ("Menu", "Close menu"). | **Not decided.** Shown in the preview only. Decide when the navigation phase is proposed. |
| D7 | Landing copy and content (fictional sample fixture, "dues tracking" wording, a footer with real destinations only). | **Not decided.** Approve before the landing PR. |
| D8 | This directory is the authority. | Done (this PR). |

Also approved on 2026-09-24: the palette; the revised tokens; the **1px boundary on a tenant's buttons** where the fill would blend into the surface.

**The preview's page layouts are not approved.** The preview was for identity, tokens, typography, navigation pattern and controls. Each page phase proposes and gets approval for its own layout.

## 2. Identity

- The product is **MATROOM**. `src/lib/platform.ts` (`PLATFORM_NAME`) is the one place the name is defined; nothing else hardcodes it.
- **Mark:** two rules skewed -12 degrees (the edges of a mat), the geometry of the approved landing reference's CSS mark redrawn as SVG in `src/components/brand/matroom-mark.tsx`. The reference shipped no logo file, so this reproduces it; it is not a new logo. It draws in `currentColor`. Minimum 16 px wide; it is decorative because the name is always present as text.
- **Wordmark:** the mark plus the name in IBM Plex Sans semibold, uppercase, -0.02em. (The reference set it in Segoe UI at weight 750, which the app does not ship.)
- **App icons** (`src/app/icon.png`, `src/app/favicon.ico`, `public/icon-192.png`, `public/icon-512.png`): the mark in `#fffefa` on a `#254b35` rounded tile (22% radius), the mark 56% of the tile width, centred. Manifest and viewport colours are the ground colours (`#f5f3ec` light, `#141d19` dark).
- Where a tenant is in scope, the tenant's own logo, or initials on its primary colour, is shown, never the MATROOM mark (`LogoMark`). No claim about a domain, trademark registration or brand clearance is made anywhere.

## 3. Tokens

`design/matroom/tokens.css` holds every colour, the radius and the default brand, under the app's existing shadcn variable names so components pick them up without renames. Forest on ivory:

| Role | Light | Dark |
|---|---|---|
| Ground `--background` | `#f5f3ec` | `#141d19` |
| Card `--card` | `#fffefa` | `#202c25` |
| Text `--foreground` | `#1d392b` | `#eff1e9` |
| Secondary text `--muted-foreground` | `#59675d` | `#b4c1b7` |
| Soft fill `--muted` / `--secondary` / `--accent` | `#e6ebdd` | `#2b3e30` |
| Brand `--primary` (default action `--brand-gold`) | `#254b35` | `#c9dfb4` |
| Label on brand | `#fffefa` | `#182a1e` |
| Hairline `--border` (decorative only) | `#d8ded3` | `#3c4e40` |
| **Control boundary `--input`** | `#738b79` | `#6d8a76` |
| Focus ring `--ring` | `#1d392b` | `#eff1e9` |
| Success / warning / error text | `#247a52` / `#92610c` / `#87271d` | `#88ddb5` / `#f4c471` / `#e48b81` |
| Chart `--data` / track `--data-track` | `#254b35` / `#e6ebdd` | `#c9dfb4` / `#2b3e30` |

Radius: `--radius` is 9 px (cards, popovers); controls use `rounded-sm` (about 5 px); pills use `rounded-4xl`.

**Thresholds** (WCAG 2.2), asserted by `design-tokens.test.ts` on the surface each pair actually sits on, in both themes: text 4.5:1 on ground, card and soft fill; control boundaries, focus rings and chart marks 3:1; status text 4.5:1 on ground, card and its own fill; status borders 3:1 on the card. The hairline `--border` is never a control's only boundary (it measures 1.2-1.9:1); form controls use `--input` (a global base rule gives every plain `input`, `select` and `textarea` that border colour).

**Focus** is a 2px ink outline with a 2px offset on every interactive element. It is not the tenant's colour (a tenant colour can be invisible on a surface); on the sidebar and banner (`data-sidebar`) it takes the sidebar's own foreground.

## 4. Tenant branding

The stored colours (`OrganizationBranding.primaryColor`, `sidebarBackground` and the derived foregrounds, hover and border) are **never changed**. `BrandingScope` emits them exactly as stored, scoped to the organization, as before, and adds three **presentation** tokens derived at render time (`src/lib/theme.ts`):

- `--action-edge`: a 1px `--input` edge on the tenant's primary buttons in the theme where the fill is under 3:1 against the card or the ground (the fictional orange in dark is 2.80:1; Alliance's stored gold in light is 1.4-1.5:1); otherwise transparent.
- `--brand-data`: the tenant colour where it colours data (the progress bar near completion), unchanged if it already clears 3:1 against the track, the card and the ground of the theme, otherwise moved along lightness (same hue) until it does.
- `--sidebar-muted`: re-declared per tenant, because a custom property using `var()` resolves where it is declared.

**Not tenant-themable, by rule:** the neutrals, the status colours and the chart colour `--data` (a director's brand colour belongs in chrome, never in what a chart measures). Label colours on a tenant fill remain derived per organization (`deriveForeground`), 4.5:1 or the warning the settings page already shows.

**Open item for the owner: new-organization defaults.** `OrganizationBranding.primaryColor` defaults to `#FACC15` and `sidebarBackground` to `#111827` in the schema, so every organization, including one that never chose a colour, has stored values and keeps the gold and near-black look inside its own tenant screens. MATROOM forest shows only where no tenant is in scope (sign-in, registration, home, platform pages). Making forest the default for organizations that never chose a colour needs a decision about what "never chose" means and a migration to change the column defaults; it is not part of Phase 1.

## 5. Typography

- IBM Plex Sans (400, 500, 600) for all UI and headings; IBM Plex Mono (400, 500) for codes, times, counts. Vendored in `src/fonts` (`README.md` there has sources, checksums and licences); Archivo was retired in Phase 1.
- `--font-display` (`font-display` utility): `Georgia, "Times New Roman", serif`, for editorial headings on Persuade surfaces only, and **not yet used by any page**. See D2 for the Android gate.
- Body 16 px, UI 14-15 px, caption 12-13 px (12 is the floor for new work); operational dashboards do not use display type. Existing labels below 12 px (the week calendar's 9.5 px day labels, some sidebar badges, tile captions) are left as they are in Phase 1 and belong to the page phases that own those screens.

## 6. Shared controls (Phase 1)

`Button`, `Input`, `Card`, `ProgressToNextGrade`, the sidebar primitives and the staff sidebar.

- **Targets:** compact on a fine pointer (`h-9` default, `h-8` small); **at least** 44px on a coarse pointer for every size, as a minimum (`pointer-coarse:min-h-11`, plus `min-w-11` for icon sizes), never a forced height: a forced `pointer-coarse:h-11` shrank the kiosk keypad and clipped multi-line controls on touch tablets (fixed 2026-09-25; see `verification/phase1/README.md`). Tailwind `pointer-coarse:`. `globals.css` adds a coarse-pointer base rule so every plain form control (any class string), checkbox (24px, and its label row 44px), and `<summary>` row is 44px too; standalone text links take `pointer-coarse:py-3`. Inline links inside a sentence are exempt (WCAG 2.5.8).
- **Hover:** a hover state never changes the fill/label pair of a filled control (a translucent hover fill took a tenant's orange to 4.3:1 under its label). Filled variants (`primary`, `destructive`, destructive `Badge` links) add a 1px inner ring in the label colour; outline, secondary and ghost change their soft fill, checked at 4.5:1 for the label after hover.
- **Boundary:** buttons other than ghost and link, and all inputs, have a `--input` border (or the tenant edge above).
- **Disabled:** shown by fill (`--muted`), text (`--muted-foreground`) and border, not by fading the tenant colour.
- **Loading:** `Button` has an optional `loading` prop: disabled, `aria-busy`, spinner beside the label (reduced-motion collapses the animation globally). Callers keep passing their own pending label.
- **Invalid:** a 2px destructive border (width changes as well as colour) plus the caller's message text. **Destructive** variants sit on the verified `--bad-soft` fill, never a translucent tint of the text colour (that measured 4.08:1 on the dark card).
- **Sidebar:** 12px caps group labels in `--sidebar-muted`; the active item has a 3px marker and heavier text in addition to its fill.
- **Progress:** a real `progressbar` with a REQUIRED accessible name (`aria-label` or `aria-labelledby`, exactly one; neither or both does not compile), value, range and `aria-valuetext` ("20 / 60"), a track edged with `--input`, the fill in `--data` (`--brand-data` near completion), and the exact value as text.
- **Card:** 9px radius, a `--border` hairline on the card surface.

## 7. Requirements for the page phases

Recorded now so they are not lost. Each is checked when the page it concerns is proposed.

1. **Compact mobile metrics.** Dashboard and portal metric tiles are compact on phones (the preview's tiles were too tall and spaced for a phone); numbers stay large, supporting text shrinks, and tiles pair up without scrolling past several screens.
2. **No cramped promotion rows.** A promotion-queue row on a phone must not squeeze the student name, the "current / target · stripe · belt" line and the action into one line (the preview wrapped the mono line badly). Stack them, keep the action reachable, and give the row real touch spacing.
3. **Meaningful chart labels and values.** Charts show units, the period and scope, real axis labels (week starts or dates, not bare 1-8) and the values, with a text or table alternative; the preview's chart used bare indexes and invented values and is not a model.
4. **Correct singular and plural messages.** Every count in a message uses an ICU plural in English and Spanish. Known defect: `dashboard.panel.sub` reads "1 students ready to grade" / "1 alumnos listos para grado". The message-parity test only checks keys, so a plural audit is part of each page phase.
5. Layouts from the preview are illustrative; each page gets its own proposal and approval.
6. The approved brief's page requirements still apply in their phases (three-step registration with preserved values and no outdated async result overwriting the latest check, the student portal's desktop grid and dedicated history view, the admin overview's constraints and priorities, and no placeholder buttons).
7. Landing: D2's Android fallback gate and D7's copy approval, before it is finalized.
8. Phone navigation: D6.
9. Form fields: roughly a dozen page-local class strings (`h-9 rounded-lg border border-input bg-transparent ...` in the payment, plan, staff, location and platform forms) still work (they get the boundary token and the global focus ring), but each page phase replaces its own with the shared `FIELD_CLASS` / `Input` from `components/ui/input.tsx`.
10. Mobile navigation sheet and tenant colours: the phone sidebar is a Sheet rendered in a portal outside the `BrandingScope` wrapper, so on a phone it shows the default MATROOM sidebar colours, not the tenant's (the desktop sidebar is tenant-coloured). This predates Phase 1 (the sheet was the default near-black regardless of tenant) and belongs to the navigation phase (D6).

## 8. Prototype-only elements that must never ship

From the approved brief: "Use demo details", "Preview submission", any design controls, mock submission confirmations, statements about information never being sent, the prototype's legal placeholder, iframes or pasted prototype documents, placeholder links and buttons, invented customers, testimonials, adoption figures, prices, trial or approval-turnaround claims, and prototype names or counts presented as data. Payments are described as dues and payment-status tracking unless processing actually exists.

## 9. Verification

Each phase records what it verified in its PR: light and dark, default and a tenant, English and Spanish, desktop and phone, in a real browser as a genuinely registered user (not a seeded account), plus the automated checks above. Anything that depends on the pointer type or on laid-out size is verified in a rendered browser under both a mouse and a coarse pointer at the target sizes (tablet landscape and portrait for the kiosk), asserting measured sizes and that content fits its control: class-name and minimum-size-only checks are not sufficient (`tests/browser`, `pnpm test:browser`). The Phase 1 verification screenshots are in `design/matroom/verification/phase1/`, the portal's in `verification/portal/` and the kiosk's in `verification/kiosk/`.

## 10. Separate findings

The registration concurrency and stale-availability findings are functional, not visual. They are not part of this design authority or of any redesign PR. In particular, no unique constraint on the organization contact email is to be added without first confirming the intended organization and contact-email policy.

## Change log

- 2026-09-24: Phase 1 foundation: authority established; identity, tokens, typography and shared controls implemented; Archivo retired.
- 2026-09-25: Student portal page phase (P1-P4 approved): two-column desktop grid, Home / Attendance / Schedule as accessible tabs, compact class rows, phone day-list schedule, theme item in the account menu; a time-based degree no longer implies attendance decides eligibility. Verification in `verification/portal/`. The kiosk redesign is a separate phase.
- 2026-09-25: Kiosk redesign phase (K1-K2, T1 approved): landscape two-column layout and portrait layout, larger keypad (Clear secondary, Enter primary), readable overlapping-class picker, offline indicator, in-flow sync banner, digit-count status and a timeout bar driven by the timer that actually resets the screen. PR #62's 44px minimum is kept (larger minimums use `pointer-coarse:` twins). Behaviour, requests and the offline queue are unchanged. Verification in `verification/kiosk/`.
