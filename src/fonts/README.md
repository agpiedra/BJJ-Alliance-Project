# Vendored fonts

The two font families the app uses (IBM Plex Sans and IBM Plex Mono) are served from this repository with `next/font/local`
(`src/app/[locale]/layout.tsx`) instead of `next/font/google`. The production build therefore makes **no request to
Google Fonts**.

## Why

`next/font/google` downloads the fonts from Google at BUILD time. When Google answers with extensionless
`https://fonts.gstatic.com/l/font?kit=...&skey=...&v=...` URLs instead of `/s/<family>/v../<file>.woff2`, the Next.js 15.5.25
Turbopack build fails with `next/font/google queries have exactly one entry`
([vercel/next.js#99114](https://github.com/vercel/next.js/issues/99114)). That failed the CI Build step on this project
(runs 35939487654 and 36055766188). Vendoring the files removes the build-time network dependency.

## What is here

The files are the upstream projects' own release files, **unmodified** (same bytes as the upstream commit). Each one is a
full-coverage file (not a per-script subset): it contains Latin, Latin Extended, Cyrillic, Greek and Vietnamese, so English and
Spanish text (including `á é í ó ú ü ñ ¿ ¡ « »`) and the Costa Rican colon sign `₡` (U+20A1, used for prices) render from
the font, not from a fallback.

| Family (CSS variable) | Weights | Files | Version | Upstream source (commit) |
|---|---|---|---|---|
| IBM Plex Sans (`--font-sans`, also headings) | 400, 500, 600 | `ibm-plex-sans/IBMPlexSans-Regular.woff2`, `-Medium.woff2`, `-SemiBold.woff2` | 3.005 | https://github.com/IBM/plex `packages/plex-sans/fonts/complete/woff2/` @ `763c36ef9117782905ae010056dfbe8fd2653a25` |
| IBM Plex Mono (`--font-mono`) | 400, 500 | `ibm-plex-mono/IBMPlexMono-Regular.woff2`, `-Medium.woff2` | 2.005 | https://github.com/IBM/plex `packages/plex-mono/fonts/complete/woff2/` @ `763c36ef9117782905ae010056dfbe8fd2653a25` |

SHA-256:

```
ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a  ibm-plex-sans/IBMPlexSans-Regular.woff2
5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d  ibm-plex-sans/IBMPlexSans-Medium.woff2
f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205  ibm-plex-sans/IBMPlexSans-SemiBold.woff2
ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350  ibm-plex-mono/IBMPlexMono-Regular.woff2
33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25  ibm-plex-mono/IBMPlexMono-Medium.woff2
```

## Licences

Both families are licensed under the **SIL Open Font License 1.1**, which allows use, embedding and redistribution with
the software. The licence text and copyright notice travel with the files:

- `ibm-plex-sans/LICENSE.txt` and `ibm-plex-mono/LICENSE.txt` - Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex"
  (the same licence text for both packages)

The files are used unmodified, so the Reserved Font Name is not affected. Do not edit, subset or re-export these files: a
modified version may not keep the "Plex" name under the OFL.

## How this differs from what `next/font/google` served

Same families, weights (IBM Plex Sans 400/500/600; IBM Plex Mono 400/500), normal style, `font-display: swap`
and the same CSS variables. Next still generates an Arial-based fallback face per family, but it computes the `size-adjust` and
`ascent`/`descent` overrides from the vendored files, so the numbers differ slightly from the ones it computed from Google's
(IBM Plex Mono: 131.49% instead of 134.59%; IBM Plex Sans within 0.05%). They only apply until the web font has loaded. Other differences, all measured when this was
changed:

- Google served the variable build of IBM Plex Sans (3.201) split into per-script subsets with
  `unicode-range`; these are the upstream static instances, one file per weight. `next/font/local` cannot express a
  per-file `unicode-range`, so the full-coverage files are used instead.
- Glyph advances and bounds match Google's files to within 2 font units (of 1000) for every Spanish/English character tested,
  with two exceptions at IBM Plex Sans 500: `...` (U+2026, 3 units) and `·` (U+00B7, 16 units = 0.016 em).
- The files are larger than the Latin subsets Google served, so the fonts preloaded on every page grow (see the pull request
  for the measured numbers).

## Archivo was retired (MATROOM Phase 1)

Headings used Archivo (600/700) until MATROOM Phase 1 (design/matroom/DESIGN.md, decision D3): they now use IBM Plex Sans
semibold, so the app loads one sans family instead of two. The Archivo files and licence were removed from this directory;
they remain in git history (commit `837db65` and earlier) if the decision is ever reversed. The editorial serif for the
landing, registration and sign-in pages is a system stack (`--font-display`, Georgia first), not a vendored file.

## Updating

Download the new release files from the upstream repositories above, replace them here, update the version, commit and
checksums in this file, and rebuild. Never point `next/font/local` at files fetched during the build.
