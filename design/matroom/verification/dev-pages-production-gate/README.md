# /dev/belts and /dev/components — production gate verification

Base: main `7db2b6a`. Follow-up recorded in PR #144 (`docs/LAUNCH_SECURITY_HEADERS_AND_BYPASS_PLAN.md`).

## What was exposed

Both pages sit under `src/app/[locale]/dev/`, outside the `(staff)` group, with no layout of their own and no
middleware gate (`route-access.ts` does not cover them) **[source]**:

- `/{es,en}/dev/belts` read the `alliance-cr` organization and its full `BeltRank` catalog from the database and
  rendered it, unauthenticated;
- `/{es,en}/dev/components` rendered a static design-system showcase.

Neither had an environment check, so both shipped in production builds.

## Change

The first statement of each page is `if (process.env.NODE_ENV === "production") notFound();`. For belts it runs before
`await params`, `getTranslations` or any Prisma call. No shared layout was added: Next renders a layout and its page in
parallel, so a layout guard would not ensure the page's database read never starts. No flags, no new helpers. Routes,
auth, branding, kiosk and the e2e bypass are unchanged. No `loading.tsx` exists anywhere in `src/app` **[source]**, so
no Suspense boundary streams a 200 before the 404. The HTTP status is checked directly anyway.

## Verification

**Unit** — `tests/unit/dev-pages-production-guard.test.ts` (4 tests). `notFound`, Prisma and `getTranslations` are
mocked.
- Under `NODE_ENV=production`, belts rejects with the `notFound` sentinel and makes zero translation, `organization` or
  `beltRank` calls; components throws the sentinel.
- Under `development`, both render and belts reads its data.
- With the guards removed (main's pages), the 2 production tests fail.

**Compiled build** — `scripts/verify-production-build.ts`, the existing CI step after "Build", extended.
- One synthetic `BeltRank` (`SYNTH-BELT-<hex>`) is added to the test database's `alliance-cr`, next to the existing
  synthetic user, and both are deleted in `finally`. Afterwards 0 users and 0 ranks remain (checked with `psql`).
- **`next start`, `NODE_ENV=test`:** for each of `/{es,en}/dev/{belts,components}` the script requires the real HTTP
  status 404 and a body containing none of `SYNTH-BELT-<hex>`, "Component library preview" or "Harbor Jiu-Jitsu".
- **`next dev`, same env:** each must return 200, belts rendering the synthetic rank and components the showcase
  heading.

| Run (local, Windows, Next 15.5.25, Turbopack) | Result |
|---|---|
| This branch | **210 ok, 0 fail** (the 194 existing checks plus 16 new) |
| Guards removed (main's pages) | **8 fail**: all four production pages return 200; belts expose `SYNTH-BELT-…`, components expose "Component library preview" and "Harbor Jiu-Jitsu". The dev control still passes |

The pages were restored byte-identical (sha256) after the mutation. No listeners were left on the test ports, and no
secret or cookie appears in any log.

## Marker correction found during verification

The first run used the translated heading ("Belt preview" / "Vista previa de cinturones") as a marker, and every
production 404 "contained" it. On a production build, `/en/login` and `/es/login` contain that string too. next-intl
ships the whole message catalog to every page, so the string says nothing about these routes. It was replaced with text
that only the gated pages render (verified with `grep` across `src` and `messages`). The catalog shipping every
namespace to every page is pre-existing, out of scope, and not changed here.

## What is observed vs not

- **Observed:** on a production build served with `NODE_ENV=test`, all four URLs return HTTP 404 without the pages'
  content. On `next dev` with the same env they render with synthetic data.
- **Source, not separately isolated:** the build compiles `process.env.NODE_ENV` to `"production"`, so runtime settings
  cannot re-enable the pages. As in PR #144, the compiled output itself was not inspected.
- **Unverified:** the hosted deployment. No live system was probed.

## Checks

`tsc --noEmit` clean · lint clean · `check:guard-usage` OK · unit and integration suites (results in the PR). The smoke
and browser suites run in CI.
