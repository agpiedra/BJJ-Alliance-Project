# Proposal: Shell & navigation phase (Phase 2.5)

**Status: PROPOSED — awaiting D6 approval and visual sign-off. Not implemented.** Prototype: `design/matroom/preview/shell-navigation-phase-prototype.html`. Review screenshots: `design/matroom/verification/shell-navigation/` (indexed in that folder's own `README.md`).

Following the same convention as the approved auth/access-state phase (`phase-auth-access-screens-proposal.md`) and the portal/kiosk phases before it — a named phase, proposed and shown before implementation, verified against a matrix before merge. This is Phase 2.5 of `docs/MATROOM_REDESIGN_EXECUTION_PLAN.md` §4, the phase that exists specifically to assign D6 (phone navigation pattern) and fix the §7.10 tenant-colour defect, neither of which belongs to any single content phase.

## What this decides: D6

`design/matroom/DESIGN.md`'s D6 is listed as **"Not decided."** The recommended pattern, shown concretely in the prototype: a phone top bar (hamburger "Menu" button + brand line) that opens a navigation sheet with its own header (wordmark + "Close menu"), nav items, and a footer (secondary actions, sign-out) — no bottom navigation, matching the pattern already approved and shipped for the student portal's own phone navigation (`04-phone-navigation.html`, Phase 1 foundation). This phase proposes extending that same pattern to the staff and platform shells, which today only have an unstyled, under-designed version of it (staff: the shadcn `Sidebar` primitive's own default mobile `Sheet` fallback, no custom header/footer; platform: no responsive treatment of any kind).

## Scope — two shells, chrome only

`src/app/[locale]/(staff)/layout.tsx` and `src/app/[locale]/platform/layout.tsx` — their sidebar, top bar, and phone navigation chrome. **Not** the content of any individual staff/platform screen (dashboard, students, payments, etc.) — those render inside whichever shell this phase ships, unchanged, and are separate phases.

## What changes

- **Staff phone navigation** moves from the shadcn `Sidebar` primitive's bare default mobile `Sheet` (today: just the sidebar's own content reused as-is inside a generic sheet) to a dedicated sheet pattern with its own header (wordmark + "Close menu") and footer (secondary actions, sign-out) — the same shape the student portal already has, giving staff and student parity per D6's "student and staff" wording.
- **Platform shell** gets a responsive treatment for the first time: today it is a plain `BrandBanner` plus three inline links with zero narrow-screen handling. This phase gives it the same top-bar + sheet pattern, scaled down (no sidebar needed for 3 links, no academy switcher, no role variation — every platform screen is superadmin-only today).
- **The tenant-colour bug (DESIGN.md §7.10) gets fixed.** Root cause, traced in the real code (not restated from the bug description alone): `src/components/ui/sheet.tsx`'s `SheetContent` wraps in `SheetPortal` → Base UI's `Dialog.Portal`, which portals into `document.body` by default. `BrandingScope` (`src/components/branding/branding-scope.tsx`) overrides `--sidebar-*`/`--brand-gold*` tokens via a `<style>` block scoped to a `[data-branding="org-…"]` DOM-wrapper selector — because that scoping is DOM-selector-based, not React Context, a portaled sheet (a React-tree descendant but not a DOM descendant of the wrapper) never receives the override and falls back to the default MATROOM colors. **Proposed fix (implementation phase, not this one):** pass Base UI's `Dialog.Portal` a `container` ref pointing at a DOM node rendered inside `BrandingScope`, so the portaled sheet becomes a real DOM descendant of the branded wrapper again. Demonstrated side-by-side in the prototype (Section C) with a fictional tenant theme.
- **Unchanged:** every existing role-based nav-item visibility rule (`src/components/staff-sidebar/nav-items.ts` — copied verbatim into the prototype, not redesigned: ADMIN sees 9 items/3 groups, DIRECTOR 6/3 — no Schedule, Staff or Locations — INSTRUCTOR 3/1), the academy/branch switcher (`AcademySwitcher`, unchanged behavior, now also surfaced inside the new mobile sheet's header instead of only the desktop sidebar header) **including its two real states** — a clickable two-line dropdown (bold current selection + "View all locations" hint + chevron) for ADMIN with 2+ branches, versus plain read-only text (no chevron, not clickable) for DIRECTOR/INSTRUCTOR always and for ADMIN too at exactly one branch, per the component's own "nothing to switch between" rule — multi-organization switching (still the existing full-page `/select-organization` redirect from Phase 1 — this phase does not add an in-shell organization switcher), tenant branding resolution, locale switching, and sign-out.
- **Organization identity and branch selection stay two distinct values, never conflated.** The breadcrumb shows the organization's name (`orgName`); the switcher pill and the avatar menu's role line show the branch name (`academyLabel`) — two different real props on `staff-top-bar.tsx`, demonstrated with two different fixtures in the prototype (Section E) so neither is mistaken for the other.

## Shared components

Reused as-is: `Sidebar`, `Sheet` (`src/components/ui/`) — both already exist and already contain the 768px mobile breakpoint (`useIsMobile`, `src/hooks/use-mobile.ts`); this phase adapts their rendering for staff/platform specifically and fixes the portal/branding interaction, it does not build new primitives. Two new message keys this phase requires, already named by D6 itself: `"Menu"` / `"Close menu"` (not yet present in `messages/en.json`/`es.json`'s `staffSidebar`/`staffShell` namespaces — confirmed absent).

## One open owner decision this prototype surfaces: the breadcrumb

`StaffTopBar`'s breadcrumb (`src/components/staff-sidebar/staff-top-bar.tsx:94`) truncates with an ellipsis today (`className="truncate …"`). The Phase 1 round-3 precedent (`OrgRow`, the switcher pill) established "wrap, never truncate a distinguishing organization name." The prototype's Section E shows what wrapping would look like there instead, labeled explicitly as a **proposed change**, not preserved behavior — nothing is lost either way, since the full name is always visible via the sheet switcher and the avatar-menu role label. **Decision needed:** keep the breadcrumb truncating as today (lowest-risk, matches production exactly), or change it to wrap (consistent with the rest of this phase's no-truncation principle). Either is a small, contained change inside this phase's own scope.

## Functionality and accessibility preserved

- Every `visible()` role rule in `nav-items.ts` — reproduced verbatim in the prototype (Section B shows all four real scenarios: ADMIN/2+ branches, ADMIN/1 branch, DIRECTOR, INSTRUCTOR — not a two-role mockup simplification).
- `AcademySwitcher`'s read-only vs. dropdown split and the separate multi-organization `/select-organization` redirect — two distinct mechanisms, both untouched (Section F).
- Tenant branding, once the §7.10 fix lands — correctly themed in both the desktop sidebar (already true today) and the phone sheet (not true today, fixed by this phase).
- Locale switching (en/es) — Section E shows the full Spanish `staffSidebar` string set, checked against `messages/es.json` and matching exactly.
- Sign-out, in both the desktop sidebar footer and the new sheet footer.

## Verification plan

- Real browser, desktop + phone, light + dark, English + Spanish, both shells (staff + platform), every role with a visibly different nav-item set (ADMIN, DIRECTOR, INSTRUCTOR for staff; platform has one role today).
- The §7.10 fix specifically verified by opening the phone sheet on a tenant with real custom branding and confirming the sheet's colors match the desktop sidebar's.
- Breadcrumb behavior (whichever option is chosen) verified with a long, real-shaped organization name at the real phone/desktop breakpoints, confirming no overlap with the theme-toggle/avatar controls.
- Existing automated tests for `nav-items.ts`'s `visible()` rules and any sidebar/sheet component tests re-run and passing; new tests added for the `Dialog.Portal` `container` fix specifically (a real regression risk if a later change reintroduces the default `document.body` target).

## Effort, dependencies, checkpoints

- **Effort estimate:** 1-1.5 weeks, MEDIUM confidence (per the execution plan — two shells, but D6's pattern is already drawn from the portal precedent, lowering design risk; the tenant-colour fix is real but bounded work).
- **Dependencies:** D6 approval — hard blocker, nothing in implementation starts without it.
- **Checkpoints:** (1) D6 approved, this proposal approved, the breadcrumb decision made; (2) implementation reviewed once per shell; (3) full verification matrix above reviewed before merge; (4) regression check against the portal/kiosk phases' own existing nav/menu patterns, since this phase's work sits directly adjacent to what they already shipped.

## Not covered by this proposal

The content of any staff or platform screen — those render inside this shell, unchanged, as separate phases. The dev-account password cleanup (separately tracked, untouched). Any database, deployment, or activation change — this is a planning/prototype proposal only.
