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
| Noto Serif (`--font-display`) | 400 only — D2's three Persuade headings need no other weight or style | `noto-serif/NotoSerif-Regular.woff2` | n/a (built from upstream variable font, see below) | https://github.com/google/fonts `ofl/notoserif/NotoSerif[wdth,wght].ttf` @ `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` |

**Noto Serif is not an unmodified upstream release file, unlike the two families above — disclosed, not hidden.**
Noto Serif's canonical upstream (`notofonts/latin-greek-cyrillic`, mirrored into `google/fonts` at the path/commit
above) ships only as a variable font (`wght`/`wdth` axes), with no static per-weight release. A static Regular
(wght=400, wdth=100) was built from that exact pinned-commit file using `fonttools varLib.instancer` 4.66.1, then
compressed to WOFF2 with `fontTools.ttLib.woff2`. This is the standard, widely-used way to derive a static weight
from a variable-only upstream family (the same operation Google Fonts' own serving infrastructure performs). The
font's design is not altered — only one fixed point on its existing weight/width axes is extracted into a static
file. Verified after instancing: resulting `name` table reads family "Noto Serif" / subfamily "Regular"; cmap
covers the same character set the IBM Plex files are required to (Latin, Latin Extended, Cyrillic, Greek,
Vietnamese, including `á é í ó ú ü ñ ¿ ¡ « »` and the Costa Rican colón sign `₡`, U+20A1 — spot-checked present in
the output font's cmap). Source variable font SHA-256 before instancing:
`4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713`.

SHA-256:

```
ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a  ibm-plex-sans/IBMPlexSans-Regular.woff2
5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d  ibm-plex-sans/IBMPlexSans-Medium.woff2
f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205  ibm-plex-sans/IBMPlexSans-SemiBold.woff2
ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350  ibm-plex-mono/IBMPlexMono-Regular.woff2
33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25  ibm-plex-mono/IBMPlexMono-Medium.woff2
7011e3a7dd3f7aacae9c7e05b7bd36582011bfdcbdef18e9de65baf16691ed9c  noto-serif/NotoSerif-Regular.woff2
```

## Licences

All three families are licensed under the **SIL Open Font License 1.1**, which allows use, embedding and
redistribution with the software. The licence text and copyright notice travel with the files:

- `ibm-plex-sans/LICENSE.txt` and `ibm-plex-mono/LICENSE.txt` - Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex"
  (the same licence text for both packages)
- `noto-serif/LICENSE.txt` - Copyright 2022 The Noto Project Authors (`https://github.com/notofonts/latin-greek-cyrillic`),
  copied verbatim from the pinned `google/fonts` commit above (`ofl/notoserif/OFL.txt`)

The IBM Plex files are used unmodified, so the Reserved Font Name is not affected. Do not edit, subset or re-export
those files: a modified version may not keep the "Plex" name under the OFL. The Noto Serif file is a static
instance derived from the upstream variable font (see the table note above) — the OFL permits this (it is
explicitly a font-modification license), and the license file travels with it regardless.

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
they remain in git history (commit `837db65` and earlier) if the decision is ever reversed.

**Update, 2026-10-13:** the editorial serif for the landing/registration/sign-in headings (`--font-display`, decision D2)
was a system stack (Georgia first) through this point; it is now Noto Serif, vendored here (`noto-serif/`), per the
table above. D2 in `design/matroom/DESIGN.md` is the decision record; this file is only the asset/provenance record.

## Updating

Download the new release files from the upstream repositories above, replace them here, update the version, commit and
checksums in this file, and rebuild. Never point `next/font/local` at files fetched during the build.
