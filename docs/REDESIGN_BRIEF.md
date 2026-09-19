# Alliance BJJ — UI redesign brief

> **Status: implemented, kept for its rationale, not an open task list.** Audited during
> MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 7 (revision 28): every phase below (0 through 9) is
> fully built — confirmed by the existence of every named component, route, and behavior, not
> assumed. Nothing here describes pending work. It stays in the repo, not folded into the main
> spec and not deleted, because ~50 source files across `src/` cite a specific phase of this
> document by name as the reasoning behind a real decision (a role gate, a matching rule, a
> token choice) — deleting it would orphan those citations for no actual gain, since there is
> no still-open work here to fold forward. Read it as design history, not a checklist.

Apply the approved visual design to the whole app, add a **Pagos** (payments) section, a
**week-calendar** schedule view, **custom promotions**, **automatic class matching for kiosk
check-ins**, and a **sign-out** control on the four account portals (not the kiosk).

**Reference mock:** `design/alliance-mock.html` (single self-contained HTML file, included with
this brief). It is the **source of truth for visual design**. Open it in a browser and click
through Panel → Alumnos → Pagos → Resumen → Horario before writing code. Where this document
and the mock disagree, the mock wins for visuals; this document wins for behavior and data.

The mock is a static prototype — **do not copy its HTML into the app.** Port it to the
project's existing React/Next.js + Tailwind conventions.

---

## Phase 0 — Stack facts (already verified — do not re-derive)

This repo was inspected before the brief was written. These are facts, not guesses:

- **Next.js 15.5 App Router**, React 19, TypeScript, pnpm, Turbopack.
- **Tailwind v4 — there is NO `tailwind.config.js`.** All theming lives in
  `src/app/globals.css`: `@theme inline` maps `--color-*` → raw `--*` variables, and `:root` /
  `.dark` define the raw values **in `oklch()`**.
- **shadcn/ui**, style `base-nova`, `cssVariables: true`, baseColor `neutral`, primitives from
  `@base-ui/react`, icons from `lucide-react`. Components live in `src/components/ui/`:
  `badge, button, card, input, separator, sheet, sidebar, skeleton, tooltip`.
- **Existing app components — extend these, do not create parallel ones:**
  `components/staff-sidebar/{staff-sidebar.tsx, nav-items.ts}`,
  `components/belt-graphic/belt-graphic.tsx`, `components/brand/{logo-mark, brand-banner}.tsx`.
- **Routes** under `src/app/[locale]/`:
  `(staff)/dashboard`, `(staff)/dashboard/analytics`, `(staff)/students`,
  `(staff)/students/[id]`, `(staff)/admin/schedule`, `(staff)/admin/kiosk-tokens`,
  `portal` (student), `kiosk/[academySlug]`, `login`, `signup`, `forgot-password`,
  `reset-password`.
- **Prisma 7** (`prisma/schema.prisma`), models already present: `Academy`, `User`, `Student`,
  `StaffAssignment`, `ClassSession`, `AttendanceRecord`, `BeltRequirement`, `Promotion`,
  `PaymentPlan`, `PaymentPeriod`, `KioskAttempt`, `Notification`, `AuditLog`.
- **next-auth v5** (`src/auth.ts`, `auth.config.ts`, `src/middleware.ts`).
- **next-intl** — every user-facing string comes from `messages/`. **No hardcoded Spanish or
  English in components.** Add new keys for everything this brief introduces.
- **luxon** for dates, with `src/lib/scheduling/zone.ts` already pinning the CR zone.
- **recharts** is installed — use it for the line chart; the bar lists and the heatmap are
  plain CSS grid and need no library.
- **vitest**, `tests/unit` and `tests/integration`, run with `pnpm test`.

### Still to check before you start

1. Which pages currently render a sign-out control (expected: none).
2. Whether `(staff)/layout.tsx` already wraps every staff route, or some pages bypass it.
3. What `nav-items.ts` lists today vs. the nav in the mock.

Report those three, then proceed. Do not re-audit the facts above.

---

## Phase 1 — Design tokens

`src/app/globals.css` already has a working shadcn token layer with a documented rule:
**gold (`--brand-gold`) is reserved for the sidebar active nav, banner accents and stat
highlights, and must never become `--primary` or `--accent`.** That rule stands — the mock
follows it. Do not restructure what is there. **Extend it**, in three ways:

### 1.1 Warm the neutrals

Today every neutral is pure grey (`oklch(L 0 0)`). The mock's neutrals carry a slight warm
bias toward the gold, which is what makes the surfaces read as chosen rather than default.
Give the existing tokens a small chroma at hue ~85 — keep the same lightness values so nothing
else shifts:

| Token | Now | Change to |
|---|---|---|
| `--background` | `oklch(0.985 0 0)` | `oklch(0.985 0.004 85)` |
| `--card` | `oklch(0.985 0 0)` | `oklch(1 0 0)` (cards sit *above* the ground) |
| `--secondary` / `--muted` / `--accent` | `oklch(0.97 0 0)` | `oklch(0.968 0.005 85)` |
| `--border` / `--input` | `oklch(0.922 0 0)` | `oklch(0.918 0.006 85)` |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.16 0.008 85)` |
| `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.55 0.012 85)` |

Mirror the same treatment in `.dark`. Re-verify contrast after the change — the existing file
documents its ratios and that convention should be kept.

### 1.2 Add the tokens that do not exist yet

Semantic status colors (only `--destructive` exists today) and the two data palettes. Add the
raw values to `:root` and `.dark`, **and** add matching `--color-*` lines to `@theme inline`
so they become Tailwind utilities (`bg-ok-soft`, `text-warn`, `bg-belt-blue`, `bg-class-gi`…):

```css
/* :root */
--ok: oklch(0.52 0.11 155);   --ok-soft: oklch(0.94 0.03 155);  --ok-line: oklch(0.85 0.06 155);
--warn: oklch(0.58 0.10 75);  --warn-soft: oklch(0.95 0.05 85); --warn-line: oklch(0.86 0.08 85);
--bad: oklch(0.53 0.16 28);   --bad-soft: oklch(0.94 0.04 28);  --bad-line: oklch(0.85 0.07 28);

--belt-white: oklch(0.94 0.015 85);  --belt-blue: oklch(0.48 0.13 255);
--belt-purple: oklch(0.43 0.16 305); --belt-brown: oklch(0.40 0.07 55);
--belt-black: oklch(0.18 0.01 285);

--class-gi: oklch(0.48 0.13 255);     --class-nogi: oklch(0.48 0.09 180);
--class-comp: oklch(0.52 0.14 35);    --class-strike: oklch(0.43 0.16 305);
--class-kids: oklch(0.47 0.09 75);    --class-open: oklch(0.45 0.03 265);
```

In `.dark`, lighten only the semantic trio (`--ok: oklch(0.76 0.11 155)` etc.) and
`--belt-white`. The class-modality colors stay identical in both themes — they are solid
blocks with white text on them, and they already meet contrast.

Reference hex equivalents, if you need to eyeball them against the mock: ok `#2E7D52`,
warn `#A9711A`, bad `#B33A2B`, belt blue `#2B5EA8`, purple `#6B3E9E`, brown `#6A4324`,
class NO-GI `#1C7A6B`, competición `#B5442E`, kids `#8A5A10`, open mat `#4A5568`.

### 1.3 Typography

The project currently has one sans and a mono. Add a display face and make the roles explicit,
loaded with `next/font/google` and wired through `@theme inline`:

| Role | Family | Variable | Used for |
|---|---|---|---|
| Display | **Archivo** 600/700 | `--font-heading` | `h1`, card titles, stat numbers, calendar day numbers |
| UI / body | **IBM Plex Sans** 400/500/600 | `--font-sans` | everything else |
| Mono | **IBM Plex Mono** 400/500 | `--font-mono` | eyebrows, table headers, times, codes |

`h1`: `font-heading`, 600, ~31px, tracking-tight, `text-wrap: balance`. Uppercase micro-labels:
mono, 9.5–10.5px, `tracking-[.11em]`, `text-muted-foreground`. **Every column of numbers gets
`tabular-nums`.**

### 1.4 The rule

After this phase, no component may contain a raw color. Everything goes through a Tailwind
utility backed by a token. If a value is missing, add a token — do not inline it.

### Typography

Load with `next/font/google`, exposed as CSS variables:

| Role | Family | Weights | Used for |
|---|---|---|---|
| Display | **Archivo** | 600, 700 | Page titles (`h1`), card titles, stat numbers, calendar day numbers |
| UI / body | **IBM Plex Sans** | 400, 500, 600 | Everything else |
| Mono | **IBM Plex Mono** | 400, 500 | Eyebrows, table headers, axis labels, times, codes |

Rules:
- `h1`: Archivo 600, ~31px, `tracking-tight`, `text-wrap: balance`.
- Uppercase micro-labels (table headers, eyebrows, field labels in filters): IBM Plex Mono,
  9.5–10.5px, `letter-spacing: .11em`, `--text-3`.
- **Every column of numbers gets `font-variant-numeric: tabular-nums`.** No exceptions.

---

## Phase 2 — Shared app shell (admin, director, instructor)

`src/components/staff-sidebar/` and `src/app/[locale]/(staff)/layout.tsx` already exist —
**extend them, do not build a parallel shell.** `nav-items.ts` is where the nav is declared;
add the new entries there rather than hardcoding links in pages. The student portal uses a
lighter version (top bar only, no rail) and the kiosk uses none of it — see Phase 8.

### Sidebar rail (`--rail` background, 232px, sticky full height)

- Brand block: 30px yellow rounded square with "A", then "Alliance" / "TATAMI".
- **Academy switcher** below the brand: shows the active academy (Escazú / Escalante) with a
  yellow dot, and switches scope for the whole session. Admin sees "Ver ambas sedes";
  director/instructor see only their own academy and the control is read-only text.
- Nav items grouped under uppercase mono section labels (`Operación`, `Análisis`, `Academia`).
  16px stroke icons, 8px gap. Active item = solid `--accent` background, `--on-accent` text,
  600 weight. Hover = `--rail-2`.
- Count badges on the right of nav items (e.g. Alumnos `9`, Pagos `2` for overdue). Pill,
  mono, 10.5px.
- **Footer pinned to the bottom**, separated by a `--rail-line` top border: `Configuración`
  and `Salir`.
- Under 860px the rail collapses to a horizontal scrolling top bar (icons + labels, badges and
  the academy switcher hidden).

### Top bar (sticky, `--surface`, 1px bottom border)

- Left: breadcrumb in mono uppercase — `Alliance Costa Rica · <Current page>`.
- Right: theme toggle, then the user avatar (initials in a circle) which opens a menu with the
  user's name, role, academy, and **Cerrar sesión**.

### Page header (inside every page, not in the shell)

```
eyebrow (mono uppercase, --text-3)
h1
sub (one sentence of real context, --text-2)              [actions, right-aligned]
```

The `sub` line must carry actual numbers, not filler. Example:
`"Escazú y Escalante · 44 asistencias esta semana, 3 alumnos listos para grado."`

---

## Phase 3 — Component library

`src/components/ui/` already has `badge, button, card, input, separator, sheet, sidebar,
skeleton, tooltip` from shadcn, and `components/belt-graphic/belt-graphic.tsx` already draws
belts. **Restyle and extend those** — adding variants to the existing `Button`/`Badge`/`Card`
rather than introducing new components with the same job. Build only what is genuinely absent
(`StatTile`, `BarList`, `Heatmap`, `WeekCalendar`, `DataTable`, `FilterBar`, `EmptyState`).

Each takes tokens only.

| Component | Notes |
|---|---|
| `Button` | variants: `primary` (accent bg), `default` (surface + border), `ghost`; sizes `md`, `sm` |
| `IconButton` | 30×30 square, used by the calendar week nav |
| `Card` | `--surface`, 1px `--line`, radius 10, `--shadow`. Slots: `title`, `note` (right-aligned meta), `body` |
| `StatTile` / `StatRow` | Tiles sit in one bordered container divided by 1px lines — **not** separate floating cards. Each tile: label (12px `--text-2`), value (Archivo 600, 30px, tabular), delta line (11.5px; green `--ok` up, red `--bad` down). Optional `flag` prop draws a 3px left rail in accent or red |
| `Pill` | `ok` / `warn` / `bad` / `accent` / `plain`. Dot + label, 20px radius. Semantic colors only — never yellow for "good" |
| `DataTable` | mono uppercase `<th>` on `--surface-2`, 12px/18px cells, row hover `--surface-2`, `overflow-x:auto` wrapper, last row has no bottom border |
| `BeltBar` | 86×14 bar: belt-colored body + black tip (red tip for black belt) + 2.5px white stripes inside the tip. Props: `belt`, `stripes` (0–4). Always paired with text `Azul · 2 franjas` |
| `ProgressToNextGrade` | 5px track + fill + mono `41 / 65`. Fill turns `--accent` at ≥ 90% |
| `BarList` | horizontal bars for ranked data (class popularity, belt distribution). Grid: `label / track / value`. **Replaces every rotated-label bar chart in the app** |
| `Heatmap` | day × time-band grid; cell background `color-mix(in srgb, var(--accent) N%, var(--surface))`, empty cells dashed border with `—` |
| `WeekCalendar` | see Phase 5 |
| `FilterBar` | row inside a card, 1px bottom border; search input with inline icon + selects |
| `EmptyState` | short sentence in `--text-3`, plus the one action that fixes it. **Never a blank chart.** A chart with no data renders the empty state instead |

Focus states: `outline: 2px solid var(--accent); outline-offset: 2px` on every interactive
element. Respect `prefers-reduced-motion`.

---

## Phase 4 — Screen specs

### 4.1 Panel (dashboard)

Order matters — actionable first:

1. Stat row of 4: **Alumnos activos**, **Asistencias esta semana**, **Listos para grado**
   (accent flag), **Mensualidad atrasada** (red flag). Every tile has a context line naming
   the actual students where it fits.
2. Two columns: **Asistencia semanal** (8-week line+area SVG, last point emphasized with a
   filled dot and its value labeled) and **Distribución de cinturones** (BarList in belt
   colors, with the 30/65/75/85 rule stated underneath).
3. Two columns: **Asistencia promedio por franja** (heatmap, rows = Mañana / Mediodía / Tarde
   / Noche, columns = Lun–Sáb) and **Cola de promociones** (belt bar + name + `29 / 30 · 4.ª
   franja blanca` + `Graduar` button), with a "Próximos" list underneath.
4. **Alumnos por contactar** — students with 7+ days absent: name, academy, phone, last
   attendance, days absent (colored by severity), payment pill, and a WhatsApp button that
   opens `wa.me` with a prefilled message.

### 4.2 Alumnos

Filter bar: search (name / email / kiosk code), belt, status, payment, academy. Default
status filter is **Activos**, not "Todos".

Columns: Alumno (name + `email · kiosco 4821` sub-line), Cinturón (`BeltBar`), Progreso
(`ProgressToNextGrade`), Academia, Última asistencia (append `· hace 20 días` in `--text-3`
when stale), Pago (pill), then a trailing cell for `Examen` / `Franja` flags.

Sort by "closest to promotion" by default so the useful rows are on top.

### 4.3 Resumen (analytics)

- Filter card: quick-range segmented control (7 días / 30 días / 90 días / Año) **plus** the
  explicit Desde/Hasta date inputs, academy select, Aplicar. Export CSV lives in the page
  header, not buried next to the filters.
- 8 stat tiles in one 4×2 bordered container, each with a comparison line vs. the previous
  period.
- **Popularidad de clases** as a `BarList`, top 12, sorted descending, with "Ver las 18
  clases" to expand. **Delete the current rotated-label bar chart entirely** — it is
  unreadable.
- Side column: **Mayor crecimiento** (key/value list, +green / −red) and **Clases en riesgo**
  (pills for classes under 4 attendances).
- **Detalle por clase** table: #, clase, modalidad, asistencias, período anterior, promedio por
  sesión, tendencia pill with a real percentage — not an arrow glyph.

### 4.4 Horario — week calendar (replaces the 18-row list)

See Phase 5.

### 4.5 Pagos (new section)

See Phase 6.

---

## Phase 5 — Week calendar

Replace the flat list of 18 classes with a week grid.

**Structure:** CSS grid, `grid-template-columns: 70px repeat(7, minmax(104px, 1fr))`,
`grid-template-rows: auto repeat(28, 24px)` — 28 half-hour tracks covering 06:00–20:00.

Place each class by computed grid row:

```ts
const rowFor = (h: number, m: number) => 2 + (h - 6) * 2 + (m === 30 ? 1 : 0)
// block: gridRow = `${rowFor(startH, startM)} / ${rowFor(endH, endM)}`
```

- Columns Dom → Sáb. Sunday column gets a diagonal hatch background (no classes).
- Today's column gets `color-mix(in srgb, var(--accent) 7%, transparent)` and its header cell
  gets `--accent-soft` with an `--accent` bottom border.
- Each block: modality title (600, 11.5px), instructor (10px, 92% opacity), time range (mono,
  9.5px, pushed to the bottom with `margin-top:auto`). White text on the modality color.
  Hover: `brightness(1.08)` and a 1px lift. Clicking opens the class detail / attendance sheet.
- Legend under the grid mapping every modality color to its name.
- Header controls: `‹ 6 – 12 de septiembre ›` + **Hoy**, a Semana / Día / Lista segmented
  control (keep the list as a third view — it is faster for taking attendance on a phone), an
  academy select, an instructor filter, and **Nueva clase**.
- Wrapper is `overflow-x: auto` with `min-width: 860px` on the grid so it scrolls on mobile
  instead of crushing.

Known issue to handle: **18:30 and 19:00 classes overlap on Wednesday and Friday.** When two
blocks share a column and overlap in time, split the column width between them (50/50) rather
than stacking them on top of each other.

Optional improvement worth doing: collapse the empty 13:00–18:00 band into a single
`5 horas sin clases` separator row so the week fits without scrolling. Behind a small toggle.

---

## Phase 6 — Pagos section (new)

The app **does not process payments.** This section only records what the director or
instructor already collected outside the app.

### 6.1 What exists today

Payments are **not** missing from the data layer — they are missing a home in the UI.
`PaymentPlan` and `PaymentPeriod` already exist in `prisma/schema.prisma`, with
`src/lib/payments/{get-current-period, list-overdue, overdue}.ts`, and the recording form lives
buried inside the student detail page:
`(staff)/students/[id]/{record-payment-form.tsx, payment-actions.ts, get-payment-history.ts}`.

So: **create the route `(staff)/payments`**, move/reuse that form there, and keep the
per-student view working by rendering the same component in both places.

### 6.2 Data model — additions only

Add to `PaymentPeriod` (keep everything already there):

| Field | Type | Notes |
|---|---|---|
| `promoName` | text, nullable | e.g. "Beca competidor", "2×1 hermanos" |
| `promoReason` | text, nullable | |
| `promoRecurring` | boolean, default false | carry forward each month until removed |
| `method` | enum, nullable | `SINPE` \| `TRANSFERENCIA` \| `EFECTIVO` \| `TARJETA` — add if absent |
| `recordedById` / `recordedAt` | fk User / timestamptz | add if absent |

Add a `CUSTOM_PROMO` member to the plan enum and an `EXONERADO` member to the status enum if
they are not already there. Generate a migration with `pnpm db:migrate`; do not hand-edit
existing migrations.

Recording a period that already exists **updates** it and writes an `AuditLog` row — never
insert a duplicate.

`status = 'exonerado'` counts as *current* for access and for the "Pagado o promoción"
analytics metric. It must never show as debt.

### 6.3 Screen

1. **Stat row of 4**: Al día, Pendiente, Atrasado (red flag), Promoción o beca — each with the
   student names underneath where the count is small.
2. **Registrar pago** card:
   - Fields: Alumno, Plan, Período (`<input type="month">`), Método, Monto (₡), Estado, Notas.
   - Footer hint: *"Marcar «Pagado» reactiva el acceso al kiosco del alumno de inmediato."*
   - **Custom promotion:** when Plan = `Promoción personalizada`, reveal an accent-tinted
     sub-panel with:
     - `Nombre de la promoción` — free text (e.g. "Beca competidor").
     - `Monto acordado (₡)` — free amount, `0` allowed for a full waiver.
     - `Motivo` — free text.
     - Checkbox: *"Repetir esta promoción todos los meses hasta que la quite"* →
       `promo_recurring`.
   - **Role gate:** the promotion sub-panel renders for `admin` and `director` only. An
     instructor selecting that plan sees "Pedile al director que registre la promoción."
     Enforce this on the server too, not only in the UI.
   - Validation: promo name required when the plan is a custom promotion; amount must be ≥ 0;
     period cannot be more than one month in the future.
3. **Estado del mes** table: Alumno, Academia, Plan, Monto, Método, Registrado (`11 sep ·
   Alexis P.`), Estado pill, and a trailing action.
   - Rows that are not paid get a **`Marcar pagado`** primary button that updates the row
     inline (optimistic update, toast on success, revert on failure) without a full reload.
   - Paid rows get `Ver recibo`; promo rows get `Editar`.
   - A custom-promo row shows the promo name under the plan, e.g. `Promoción · Beca
     competidor`.

---

## Phase 7 — Sign-out, on the four account portals

There is currently no way to sign out. Add it in these four places, wired to the same
`signOut()` action:

| Portal | Where |
|---|---|
| Admin | Rail footer `Salir` **and** the avatar menu in the top bar |
| Director | Same as admin |
| Instructor | Same as admin |
| Student | Avatar menu in the top bar (the student portal has no rail) |

Signing out clears the session, the selected academy, and any cached student data, then
redirects to the login screen. The login screen uses the same tokens: `--ground` background,
one centered card, the Alliance mark, accent primary button.

**The kiosk has no sign-out and no session of its own.** It is a shared station that stays
open on the wall: the only thing it ever asks for is the student's 4-digit PIN to mark
attendance. Do not add a logout control, an account menu, or a staff exit to it — nothing in
the kiosk UI should be tied to a logged-in user.

---

## Phase 8 — Apply the style to the remaining portals

Same tokens, same components, adjusted density:

- **Student portal** — no rail. Top bar with the Alliance mark and the avatar menu. Content:
  their own `BeltBar` + `ProgressToNextGrade` as the hero, attendance history, payment status
  pill, and the week calendar read-only (no edit, no instructor filter).
- **Kiosk** — this is the one screen that breaks the density rules. It is a wall-mounted tablet
  read at 1–2 metres: a 4-digit PIN entry with ~64px numerals, huge tap targets, and a
  full-screen success state showing the student's name, belt, and updated count
  (`24 / 30 · faltan 6`), which auto-returns to the PIN pad after a few seconds so the next
  student can mark in. Same palette and fonts, no rail, **no account menu and no sign-out** —
  the PIN is the only input the screen ever takes.
- **Instructor** — admin layout minus Pagos write access, Configuración, and the academy
  switcher; scoped to their own academy.
- **Director** — admin layout scoped to one academy, but keeps full Pagos access including
  custom promotions.

---

## Phase 9 — Kiosk check-in: attach the attendance to the nearest class

> **Read `src/lib/scheduling/check-in-window.ts` before writing a single line here.**
> The nearest-class matching **already exists** and is deliberately designed. Do **not**
> rewrite it, do not "improve" its window, and do not introduce a second matcher.

### What already works

`selectActiveSessionOccurrence()` already picks the class occurrence for a check-in:

- Window: **start − 30 min to start + 30 min**, anchored to the class start (not the end).
  The file documents *why* it is not `start − 30 .. end + 30`: with back-to-back hourly
  classes — which the Escazú schedule genuinely has — the wider window made adjacent classes
  overlap by a full hour and the same tap could be attributed to either one.
- Selection: nearest scheduled start wins; tie → the **earlier** start (at that instant the
  earlier class is already under way); still tied → lowest id, for determinism.
- It checks yesterday / today / tomorrow in CR time so a window crossing local midnight still
  resolves, and it returns `anchorDate` so attendance is bucketed by the *occurrence's* day,
  not the wall-clock day.

Verify it against the real Escazú schedule — these should already pass, and are worth adding
to `tests/unit` if they are not covered:

| Check-in | Expected |
|---|---|
| Mon 17:52 | **18:00 GI Principiantes** |
| Mon 18:40 | **19:00 GI Avanzados** (18:00's window ended at 18:30) |
| Wed 18:10 | **18:30 Competición** |
| Fri 18:52 | **18:30 GI Todos** |
| Sat 09:50 | **10:00 Kids** |
| Mon 18:30 exactly | **18:00** (tie → earlier) |
| Mon 13:30 | **no match** — see below |

### What is actually missing — build only this

1. **The no-match path.** Today a tap outside every window has nowhere to go. Instead of
   rejecting it: show that day's classes at that academy as large buttons and let the student
   pick. Record `matchSource = 'STUDENT_PICKED'`. If the day has no classes at all, still save
   the attendance with a null session and `matchSource = 'UNMATCHED'`, and surface it for staff
   review — never silently drop a tap.
2. **Show the match on the confirmation screen.** The kiosk must name the class it chose
   (*"Asistencia guardada en — GI · Todos los niveles, viernes 18:30"*) with a
   *"¿No es esta clase?"* link that reassigns it on the spot. **This is the safety net that
   makes automatic matching acceptable — do not ship without it.**
3. **Provenance on `AttendanceRecord`.** Add:

   | Field | Type | Notes |
   |---|---|---|
   | `matchSource` | enum | `AUTO` \| `STUDENT_PICKED` \| `STAFF_CORRECTED` \| `UNMATCHED` |
   | `correctedById` | fk User, nullable | set when staff reassigns |
   | `correctedAt` | timestamptz, nullable | |

   Keep `checkedInAt` as the raw instant even after a correction. If `classSessionId` is not
   nullable today, make it nullable for the `UNMATCHED` case.
4. **Staff reassignment.** From the kiosk activity list, an instructor can move an attendance
   to another class that day; that sets `STAFF_CORRECTED` + `correctedById`, writes an
   `AuditLog` row, and adjusts both classes' counts.
5. **`Marcajes de hoy`** on the admin/director Kiosco page: time, student, assigned class, a
   provenance pill (`Automática` / `Elegida por el alumno` / `Corregida`), and a `Cambiar`
   action. See the mock's Kiosco page.

### Things that already hold and must not regress

- Matching is **server-side** (`src/app/api/kiosk/check-in/route.ts` →
  `src/lib/kiosk/perform-check-in.ts`). The tablet's clock is not trusted.
- All time math goes through **luxon** with `src/lib/scheduling/zone.ts`. Do not add `Date`
  arithmetic or a second timezone constant.
- **Duplicates:** one attendance per `(student, classSession, occurrence day)`. A second tap
  for the same class shows *"Ya marcaste esta clase"* with the count unchanged — not an error,
  not a double count. Two *different* classes on the same day are legitimate and both count.
- The offline queue (`src/lib/kiosk/offline-queue.ts`, `queued-at.ts`) replays taps with their
  **original** timestamp. Matching must run against `queuedAt`, not replay time, or a queued
  tap lands in the wrong class.
- Attendance counts toward the student's **home** academy totals and their belt progression
  regardless of which site's kiosk was used; the academy on the record is where the tap
  happened, not who gets the credit.

### Kiosk screens (see the mock's Kiosco page for both states)

1. **PIN pad** — four dots, 3×4 numpad, `Borrar` / `Entrar` in gold, date and time at the
   bottom.
2. **Confirmation** — green check, `¡Listo, <nombre>!`, belt graphic, progress
   (`63 / 65 · faltan 2 para el examen`), the matched class in its own panel labeled
   *"Asistencia guardada en"*, the *"¿No es esta clase?"* link, and auto-return to the PIN pad
   after ~5 seconds.

### Kiosk screens (see the mock's Kiosco page for both states)

1. **PIN pad** — four dots, 3×4 numpad, `Borrar` / `Entrar` in accent, date and time at the
   bottom.
2. **Confirmation** — green check, `¡Listo, <nombre>!`, their belt bar, progress
   (`63 / 65 · faltan 2 para el examen`), then the matched class in its own panel labeled
   *"Asistencia guardada en"*, the *"¿No es esta clase?"* link, and an auto-return to the PIN
   pad after ~5 seconds.

The admin/director **Kiosco** page gets a `Marcajes de hoy` table: time, student, assigned
class, an `Automática` / `Elegida por el alumno` / `Corregida` pill, and a `Cambiar` action.

---

## Rules that apply everywhere

1. **No hard-coded colors.** Tokens only. If a value is missing, add a token.
2. **Semantic color ≠ brand color.** Yellow is the brand and the "needs attention / eligible"
   accent. Green/amber/red are status. Never use yellow to mean "good".
3. **Both themes ship.** Every screen must be checked in light and dark. Define every color in
   `:root` first; `.dark` only *redefines* tokens.
4. **Never render an empty chart.** No data → `EmptyState` with the action that fixes it.
5. **Numbers get context.** A stat tile with only a number is incomplete; add the comparison or
   the names behind it.
6. **Phone width (~400px) works** on every page: rail collapses, grids stack to one column,
   tables and the calendar scroll horizontally inside their own container — the page body never
   scrolls sideways.
7. **Accessibility:** visible focus rings, `aria-current="page"` on the active nav item,
   `aria-pressed` on segmented controls, real `<label>`s and stable `id`s on every input, and
   status conveyed by text as well as color.
8. **Don't touch business logic.** Belt rules (30/65/75/85, 4 stripes max), attendance
   counting across both academies, kiosk PIN auth, the check-in window and the offline queue
   stay exactly as they are. The only schema changes in this brief are the `PaymentPeriod`
   additions (Phase 6) and the `AttendanceRecord` provenance fields (Phase 9).
9. **Every string goes through next-intl.** Add keys to `messages/` for all new copy, in both
   locales. No literal text in components.
10. **This is a restyle, not a rewrite.** Prefer editing an existing file over creating a new
    one. If you find yourself creating `AppShell2` or a second check-in matcher, stop.

---

## Verification checklist

Before calling it done:

- [ ] Every route renders inside `AppShell`; no page has its own nav.
- [ ] Sign-out reachable from admin, director, instructor and student; the kiosk has none and
      asks only for the student's PIN.
- [ ] `grep` finds no hex/oklch color literals in `src/components/` or `src/app/` outside
      `globals.css`.
- [ ] `pnpm test` passes, including new unit tests for the check-in matching table in Phase 9.
- [ ] `pnpm build` passes with no new type errors.
- [ ] No literal user-facing strings outside `messages/`.
- [ ] Every page screenshotted in light **and** dark at 1440px and 390px.
- [ ] Pagos: record a mensualidad, record a custom promotion with amount `0` and
      `promo_recurring` on, then confirm the next month inherits it and the student still shows
      as current in the kiosk and in "Pagado o promoción".
- [ ] Instructor account cannot see or submit the promotion panel — verified against the API,
      not just the UI.
- [ ] Calendar: Wednesday 18:30 Competición and Friday 18:30 GI render without overlapping
      their 19:00 neighbours; "Hoy" highlights the correct column.
- [ ] Analytics with an empty date range shows empty states, not blank axes.
- [ ] Tab through Panel, Alumnos, Pagos and Horario using only the keyboard.
- [ ] Kiosk matching unchanged: Mon 18:40 → **19:00**, Fri 18:52 → **18:30 GI Todos**,
      Mon 18:30 exactly → **18:00** (tie goes to the earlier class). Mon 13:30 → the student
      is asked to pick.
- [ ] A tap replayed from the offline queue lands in the class its *original* timestamp
      matched, not the class active at replay time.
- [ ] Tapping the same PIN twice for one class does not double-count and shows
      "Ya marcaste esta clase".
- [ ] The confirmation screen names the class and the "¿No es esta clase?" link reassigns it.
- [ ] A check-in just before midnight is attributed to the correct local day.
