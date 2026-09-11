"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { regenerateKioskToken, type RegenerateKioskTokenState } from "./actions";

const INITIAL_STATE: RegenerateKioskTokenState = {};

// Rendered only for an ADMIN session (page.tsx gate) — the real enforcement
// is server-side in `regenerateKioskToken` itself (requireStaffSession(["ADMIN"])),
// never this UI check alone.
export function RegenerateKioskTokenButton({
  academyId,
  academySlug,
}: {
  academyId: string;
  academySlug: string;
}) {
  const t = useTranslations("adminKioskTokens");
  const locale = useLocale();
  const [state, formAction, isPending] = useActionState(regenerateKioskToken, INITIAL_STATE);

  // Built client-side from the plaintext token this action just returned —
  // never round-tripped through the server a second time, since the token
  // is never persisted anywhere for a later read to find.
  const kioskUrl =
    state.ok && state.token
      ? `${window.location.origin}/${locale}/kiosk/${academySlug}?token=${state.token}`
      : null;

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(t("confirm"))) {
          event.preventDefault();
        }
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="academyId" value={academyId} />
      {kioskUrl && (
        <div className="flex flex-col gap-2 rounded border border-green-600 bg-green-50 p-3">
          <p>{t("successTokenWarning")}</p>
          <p className="break-all font-mono text-sm font-bold">{kioskUrl}</p>
        </div>
      )}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" variant="outline" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
