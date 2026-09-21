"use client";

import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  changeOrganizationCurrency,
  createPlan,
  deactivatePlan,
  reactivatePlan,
  updatePlan,
} from "@/lib/payments/plan-actions";
import { CURRENCIES, currencySymbol } from "@/lib/payments/format-money";
import type { Currency } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const INPUT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export interface PlanRowData {
  id: string;
  name: string;
  description: string | null;
  defaultAmount: number | null;
  active: boolean;
  /** The academy's system-managed custom-promotion plan: shown, never editable. */
  isSystem: boolean;
}

export function CreatePlanForm({
  organizationId,
  academyId,
  currency,
}: {
  organizationId: string;
  academyId: string;
  currency: Currency;
}) {
  const t = useTranslations("payments.plans");
  const [state, formAction, isPending] = useActionState(createPlan.bind(null, organizationId), INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("create.heading")}</p>
      <input type="hidden" name="academyId" value={academyId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.name")}</span>
          <input type="text" name="name" required maxLength={80} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.description")}</span>
          <input type="text" name="description" maxLength={200} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.defaultAmount", { currency: currencySymbol(currency) })}</span>
          <input type="number" name="defaultAmount" min={0} step="0.01" className={INPUT} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("create.defaultAmountHint")}</p>
      {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("create.success")}</p>}
      <div>
        <Button type="submit" disabled={isPending}>
          {t("create.submit")}
        </Button>
      </div>
    </form>
  );
}

function EditPlanForm({
  organizationId,
  plan,
  currency,
  onDone,
}: {
  organizationId: string;
  plan: PlanRowData;
  currency: Currency;
  onDone: () => void;
}) {
  const t = useTranslations("payments.plans");
  const [state, formAction, isPending] = useActionState(updatePlan.bind(null, organizationId), INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <input type="hidden" name="planId" value={plan.id} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.name")}</span>
          <input type="text" name="name" required maxLength={80} defaultValue={plan.name} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.description")}</span>
          <input type="text" name="description" maxLength={200} defaultValue={plan.description ?? ""} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("create.defaultAmount", { currency: currencySymbol(currency) })}</span>
          <input
            type="number"
            name="defaultAmount"
            min={0}
            step="0.01"
            defaultValue={plan.defaultAmount ?? ""}
            className={INPUT}
          />
        </label>
      </div>
      {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("edit.success")}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {t("edit.save")}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("edit.close")}
        </Button>
      </div>
    </form>
  );
}

/** One plan's actions: edit inline, and deactivate / reactivate — never delete. */
export function PlanRowActions({
  organizationId,
  plan,
  currency,
}: {
  organizationId: string;
  plan: PlanRowData;
  currency: Currency;
}) {
  const t = useTranslations("payments.plans");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (plan.isSystem) {
    return <span className="text-xs text-muted-foreground">{t("systemPlanNote")}</span>;
  }

  function toggleActive() {
    if (plan.active && !window.confirm(t("deactivate.confirm"))) return;
    setError(null);
    startTransition(async () => {
      const result = plan.active ? await deactivatePlan(organizationId, plan.id) : await reactivatePlan(organizationId, plan.id);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {t("edit.open")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={toggleActive} disabled={isPending}>
          {plan.active ? t("deactivate.button") : t("reactivate.button")}
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{t(`error.${error}` as never)}</p>}
      {editing && <EditPlanForm organizationId={organizationId} plan={plan} currency={currency} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** Owner only. Changing it never rewrites a payment already recorded. */
export function CurrencyForm({ organizationId, current }: { organizationId: string; current: Currency }) {
  const t = useTranslations("payments.plans");
  const [state, formAction, isPending] = useActionState(changeOrganizationCurrency.bind(null, organizationId), INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span>{t("currency.label")}</span>
        <select name="currency" defaultValue={current} className={INPUT}>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {t(`currencyOption.${currency}`)}
            </option>
          ))}
        </select>
      </label>
      {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("currency.success")}</p>}
      <div>
        <Button type="submit" disabled={isPending}>
          {t("currency.submit")}
        </Button>
      </div>
    </form>
  );
}
