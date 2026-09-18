import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { PLATFORM_NAME } from "@/lib/platform";
import "../globals.css";

// Populates the --font-heading / --font-sans / --font-mono custom properties
// referenced by globals.css's @theme inline block (REDESIGN_BRIEF.md Phase
// 1.3 — replaces the brand redesign's original Geist/Geist Mono pair).
const archivo = Archivo({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// PWA installability (Task 7, spec §10): the manifest link and theme color
// live here — not the outer src/app/layout.tsx pass-through — since this is
// the layout that actually renders <html>/<head>.
export const viewport: Viewport = {
  themeColor: "#171717",
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
      className={`${archivo.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}
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
