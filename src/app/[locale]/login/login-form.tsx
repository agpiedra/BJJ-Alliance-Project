"use client";

import { Suspense, useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthCard } from "@/components/auth/auth-card";
import type { LogoMarkProps } from "@/components/brand/logo-mark";
import { login } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

/**
 * Split out of page.tsx (MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4) so the
 * page itself can become an async Server Component — it needs to do the
 * single-organization branding lookup (platform-lookups.ts's
 * `resolveSingleOrganizationBranding`) before rendering, which a
 * `"use client"` file can't do. This component is unchanged from before
 * that split, just relocated.
 *
 * `brand` is the real org branding `/o/[orgSlug]/login` already resolves
 * server-side and used to hand to `BrandBanner`; threaded straight through
 * to `AuthCard`'s own `LogoMark`, unchanged. Bare `/login` passes nothing —
 * same generic platform wordmark it has always shown.
 */
export function LoginForm({ brand }: { brand?: LogoMarkProps }) {
  return (
    <Suspense fallback={null}>
      <LoginFormInner brand={brand} />
    </Suspense>
  );
}

function LoginFormInner({ brand }: { brand?: LogoMarkProps }) {
  const t = useTranslations("auth.login");
  const params = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? undefined;

  const [state, formAction, isPending] = useActionState(
    login.bind(null, params.locale, callbackUrl),
    INITIAL_ACTION_STATE,
  );

  return (
    <AuthCard
      title={t("heading")}
      brand={brand}
      footer={
        <a href={`/${params.locale}/register-academy`} className="mt-4 text-sm underline pointer-coarse:py-3">
          {t("registerAcademy")}
        </a>
      }
    >
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <Input type="email" name="email" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("password")}</span>
          <Input type="password" name="password" required />
        </label>
        {state.error && <p className="text-sm text-destructive">{t(state.error)}</p>}
        <Button type="submit" variant="primary" disabled={isPending}>
          {t("submit")}
        </Button>
        <a href={`/${params.locale}/forgot-password`} className="text-sm underline pointer-coarse:py-3">
          {t("forgotPassword")}
        </a>
      </form>
    </AuthCard>
  );
}
