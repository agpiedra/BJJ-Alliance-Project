import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { PLATFORM_NAME } from "@/lib/platform";
import "../globals.css";

// Populates the --font-sans / --font-mono / --font-display custom properties referenced by globals.css's @theme
// inline block. Headings use IBM Plex Sans semibold too (globals.css maps --font-heading to --font-sans): MATROOM
// Phase 1 retired Archivo, so the app loads one sans family and one mono family. Body typography is unchanged by
// D2 (design/matroom/DESIGN.md) — only --font-display (the three Persuade-surface headings) moved from a system
// Georgia stack to this vendored Noto Serif file.
//
// The files are vendored in src/fonts (sources/licences/provenance documented in src/fonts/README.md — Noto
// Serif is a static instance built from the upstream variable font, disclosed there, not a byte-identical
// release like the two IBM Plex families) and loaded with next/font/local, so the build never asks Google (or
// any third party) for a font at build OR runtime: next/font/google previously failed the build whenever Google
// answered with /l/font?kit=... URLs (vercel/next.js#99114). Same discipline applied to Noto Serif from the
// start, not just inherited.
const ibmPlexSans = localFont({
  variable: "--font-sans",
  src: [
    { path: "../../fonts/ibm-plex-sans/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-sans/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../fonts/ibm-plex-sans/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
});

const ibmPlexMono = localFont({
  variable: "--font-mono",
  src: [
    { path: "../../fonts/ibm-plex-mono/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-mono/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
});

// D2 (design/matroom/DESIGN.md): the three approved Persuade-surface headings only (register-academy, Login,
// landing) — applied opt-in per caller via a className, never globally. 400/normal only: no heading anywhere in
// scope uses bold or italic serif text (design/matroom/preview/preview.css's .display is font-weight: 400).
const notoSerif = localFont({
  variable: "--font-display",
  src: [{ path: "../../fonts/noto-serif/NotoSerif-Regular.woff2", weight: "400", style: "normal" }],
  display: "swap",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// PWA installability (Task 7, spec §10): the manifest link and theme color
// live here — not the outer src/app/layout.tsx pass-through — since this is
// the layout that actually renders <html>/<head>.
export const viewport: Viewport = {
  // MATROOM ground colours (design/matroom/tokens.css --background), by the OS colour scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#141d19" },
  ],
};

export function generateMetadata(): Metadata {
  // MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — the browser-tab title is
  // global (resolved once, before any organization is known), so it names
  // the platform, never Alliance. `manifest` is intentionally absent here:
  // `src/app/manifest.ts` is Next's own file-convention route, which
  // auto-injects the `<link rel="manifest">` itself.
  return { title: PLATFORM_NAME };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} ${notoSerif.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Runs before hydration so the "dark" class is already correct on
            first paint — suppressHydrationWarning above tells React not to
            complain that this script's class mutation doesn't match the
            server-rendered <html> (REDESIGN_BRIEF.md Phase 2 theme toggle). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("theme");var d=s?s==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);}catch(e){}})();`,
          }}
        />
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
