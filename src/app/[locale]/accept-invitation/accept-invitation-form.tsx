"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { acceptInvitation } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import type { InvitationSummary } from "@/lib/staff/describe-invitation";

/**
 * The accept page's form. Which fields it shows is decided by the SERVER
 * (`describeInvitation`), never guessed here: someone who already has an account
 * is never asked for a password — and `acceptInvitation` ignores one anyway.
 */
export function AcceptInvitationForm({ locale, token, summary }: { locale: string; token: string; summary: InvitationSummary }) {
  const t = useTranslations("auth.acceptInvitation");
  const tRole = useTranslations("staffShell.userMenu.role");
  const [state, formAction, isPending] = useActionState(acceptInvitation.bind(null, locale), INITIAL_ACTION_STATE);

  if (!summary.valid) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
        <p className="max-w-sm text-center text-sm text-destructive">{t("invalidToken")}</p>
      </main>
    );
  }

  const params = { organization: summary.organizationName, role: tRole(summary.role as never) };

  // An existing account just joined: no session is minted from a link, so send them to sign in.
  if (state.ok) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-2xl font-bold">{t("joined", { organization: summary.organizationName })}</h1>
        <p className="max-w-sm text-center text-sm text-muted-foreground">{t("joinedBody")}</p>
        <a href={`/${locale}/login`} className="underline">
          {t("signIn")}
        </a>
      </main>
    );
  }

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{summary.mode === "join" ? t("headingJoin", params) : t("heading")}</h1>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {summary.mode === "join" ? t("joinBody", params) : t("invitedAs", params)}
      </p>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        {summary.mode === "setPassword" && (
          <label className="flex flex-col gap-1">
            <span>{t("newPassword")}</span>
            <input type="password" name="password" required minLength={8} className="rounded border px-3 py-2" />
          </label>
        )}
        {state.error && <p className="text-sm text-destructive">{t(state.error as never)}</p>}
        <Button type="submit" variant="primary" disabled={isPending}>
          {summary.mode === "join" ? t("joinSubmit") : t("submit")}
        </Button>
      </form>
    </main>
  );
}
