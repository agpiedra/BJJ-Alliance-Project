import { notFound } from "next/navigation";

/**
 * Next only renders the ROOT `app/not-found.tsx` for a URL that matches no
 * route at all — a nested `[locale]/not-found.tsx` is reached only when
 * `notFound()` is called from inside that segment. This catch-all makes every
 * unmatched path under a locale prefix match the `[locale]` segment first, so
 * the localized not-found page renders inside `[locale]/layout.tsx` (which is
 * what supplies the `<html>`/`<body>` tags). See next-intl's "error files"
 * docs. A more specific route always wins over this catch-all.
 */
export default function CatchAllPage() {
  notFound();
}
