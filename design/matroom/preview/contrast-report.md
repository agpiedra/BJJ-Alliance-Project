# Contrast audit on rendered surfaces

Generated 2026-09-24T23:43:03.828Z by `tools/audit.cjs` in headless Chromium at 1280 px (reduced motion).

**Method.** For every rendered element the tool takes the colour actually painted behind it (background colours composited up the DOM, not a token pair) and measures WCAG 2.2 contrast: text 4.5:1 (3:1 for text ≥24 px, or ≥18.66 px bold), placeholders 4.5:1, control boundaries 3:1 (1.4.11: the border if the control has one, otherwise its fill, against what it sits on), progress/chart marks 3:1 against their track/card, focus rings 3:1, meaningful icons 3:1. Disabled controls are exempt and only counted.

**Result.** 1792 measurements on 38 rendered stages; 0 below threshold (0 distinct); 84 disabled-control measurements exempt.

| Check | Measured | Below threshold |
|---|---:|---:|
| text | 1358 | 0 |
| boundary | 166 | 0 |
| data-mark | 24 | 0 |
| icon | 216 | 0 |
| placeholder | 4 | 0 |
| focus-ring | 24 | 0 |

## Below threshold (distinct)

None.

## Lowest measurement per group

| Kind | Theme | Brand | Ratio | Need | Element | fg on bg |
|---|---|---|---:|---:|---|---|
| boundary | light | default | 3.32 | 3 | `a.btn.btn-secondary` “Sign in” | #738b79 on #f5f3ec |
| boundary | dark | default | 3.83 | 3 | `button.btn.btn-secondary.btn-sm` “Sign out” | #6d8a76 on #202c25 |
| boundary | light | tenant | 3.32 | 3 | `button.btn.btn-secondary` “Mostrar asistencias anteriores” | #738b79 on #f5f3ec |
| boundary | dark | tenant | 3.83 | 3 | `button.btn.btn-secondary.btn-sm` “Cerrar sesión” | #6d8a76 on #202c25 |
| data-mark | light | default | 8.09 | 3 | `i`  | #254b35 on #e6ebdd |
| data-mark | dark | default | 8.01 | 3 | `i`  | #c9dfb4 on #2b3e30 |
| data-mark | light | tenant | 4.26 | 3 | `i`  | #c2410c on #e6ebdd |
| data-mark | dark | tenant | 3.01 | 3 | `i`  | #e84e0e on #2b3e30 |
| focus-ring | light | default | 11.31 | 3 | `button.btn.btn-primary.is-focus` “Check in” | #1d392b on #f5f3ec |
| focus-ring | dark | default | 12.72 | 3 | `a.navitem.is-focus` “Payments · focus” | #eff1e9 on #202c25 |
| focus-ring | light | tenant | 11.31 | 3 | `button.btn.btn-primary.is-focus` “Registrar” | #1d392b on #f5f3ec |
| focus-ring | dark | tenant | 11.49 | 3 | `a.navitem.is-focus` “Pagos · focus” | #fbfaf6 on #123b4a |
| icon | light | default | 4.54 | 3 | `svg`  | #247a52 on #e4f1eb |
| icon | dark | default | 5.37 | 3 | `svg`  | #e48b81 on #422724 |
| icon | light | tenant | 4.54 | 3 | `svg`  | #247a52 on #e4f1eb |
| icon | dark | tenant | 4.96 | 3 | `svg`  | #fbfaf6 on #c2410c |
| placeholder | light | default | 5.91 | 4.5 | `input.input` “name@example.com” | #59675d on #fffefa |
| placeholder | dark | default | 7.77 | 4.5 | `input.input` “name@example.com” | #b4c1b7 on #202c25 |
| placeholder | light | tenant | 5.91 | 4.5 | `input.input` “name@example.com” | #59675d on #fffefa |
| placeholder | dark | tenant | 7.77 | 4.5 | `input.input` “name@example.com” | #b4c1b7 on #202c25 |
| text | light | default | 4.54 | 4.5 | `span.badge.ok` “Open now” | #247a52 on #e4f1eb |
| text | dark | default | 5.37 | 4.5 | `span.badge.bad` “Overdue” | #e48b81 on #422724 |
| text | light | tenant | 4.54 | 4.5 | `span.badge.ok` “Abierta ahora” | #247a52 on #e4f1eb |
| text | dark | tenant | 4.96 | 4.5 | `span.logo-ph` “H” | #fbfaf6 on #c2410c |

## Horizontal overflow at a real 390 px viewport

| Page | scrollWidth | innerWidth | Horizontal scroll |
|---|---:|---:|---|
| 02-student-portal | 390 | 390 | no |
| 03-staff-dashboard | 390 | 390 | no |
| 04-phone-navigation | 390 | 390 | no |
| 05-controls-states | 390 | 390 | no |
| 01-identity-typography | 390 | 390 | no |

## Not covered

Images, the belt graphic’s interior stripes (decorative; the belt has a text alternative), hover states, the scrim-dimmed content behind an open menu (inert while open), and any platform where Georgia is absent. The Persuade serif specimen uses whatever serif the machine substitutes.