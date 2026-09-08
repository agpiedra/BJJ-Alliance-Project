"use client";

import { useTranslations } from "next-intl";

/**
 * Route-segment error boundary for everything under `/[locale]`.
 *
 * Without one, a thrown error anywhere in this tree falls through to Next's
 * bare global handler — an unstyled, untranslated crash page. The most
 * common way to reach it is not a bug at all but an authorization decision:
 * `requireStaffSession(["ADMIN", "DIRECTOR"])` throws `Error("FORBIDDEN")`
 * when an INSTRUCTOR reaches a director-only action, which is a deliberate,
 * expected rejection that should look like one.
 *
 * The message is deliberately generic and carries no `error.message` — the
 * thrown text can name internal state, and in production Next redacts it to
 * a digest anyway.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("error");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>
      <button onClick={reset} className="underline">
        {t("retry")}
      </button>
      {/* Next replaces the message with an opaque digest in production;
          surfacing it is the only way a user can quote something that
          correlates to the real server-side log line. Nothing sensitive —
          it is a hash, not the message. */}
      {error.digest && <p className="text-xs text-muted-foreground">{error.digest}</p>}
    </main>
  );
}
