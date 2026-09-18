"use client";

import { Suspense, useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { login } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

/**
 * Split out of page.tsx (MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4) so the
 * page itself can become an async Server Component — it needs to do the
 * single-organization branding lookup (platform-lookups.ts's
 * `resolveSingleOrganizationBranding`) before rendering, which a
 * `"use client"` file can't do. This component is unchanged from before
 * that split, just relocated.
 */
export function LoginForm() {
  return (
    <Suspense fallback={null}>
      <LoginFormInner />
    </Suspense>
  );
}

function LoginFormInner() {
  const t = useTranslations("auth.login");
  const params = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? undefined;

  const [state, formAction, isPending] = useActionState(
    login.bind(null, params.locale, callbackUrl),
    INITIAL_ACTION_STATE,
  );

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t("heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span>{t("email")}</span>
              <input type="email" name="email" required className="rounded border border-input px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span>{t("password")}</span>
              <input type="password" name="password" required className="rounded border border-input px-3 py-2" />
            </label>
            {state.error && <p className="text-sm text-destructive">{t(state.error)}</p>}
            <Button type="submit" variant="primary" disabled={isPending}>
              {t("submit")}
            </Button>
            <a href={`/${params.locale}/forgot-password`} className="text-sm underline">
              {t("forgotPassword")}
            </a>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
