"use client";

import { useId, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { addPlanTerms, addPolicyVersion, correctPlanTerms, correctPolicyVersion, createPackagePlan } from "@/lib/dues/config-actions";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { Currency } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

/**
 * The owner's dues forms (PR 3). Money and day inputs are `type="text"` with `inputMode` (a `type="number"` value is a locale-dependent
 * float and would hide what was typed); the server parses the exact text. Every control is a MATROOM `Input` or a native `<select>`
 * with `FIELD_CLASS`. Each form disclosure is a native `<details>`, so it works from the keyboard without script.
 */

const INITIAL_STATE: ActionState = {};
const INVALID_SELECT = "aria-invalid:border-2 aria-invalid:border-destructive";

type MonthDefaults = { year: number; month: number };

/**
 * Submits through a handler instead of the form `action` prop: React 19 clears every field after a form action finishes, even a refused
 * one, and an owner who mistyped one price should not have to retype the rest. The form is cleared only after a successful save.
 */
function useDuesAction(action: (prevState: ActionState, formData: FormData) => Promise<ActionState>) {
  const [state, setState] = useState<ActionState>(INITIAL_STATE);
  const [isPending, startTransition] = useTransition();
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      const result = await action({}, data);
      setState(result);
      if (result.ok) form.reset();
    });
  };
  return { state, onSubmit, isPending };
}

function TextField({
  label,
  name,
  defaultValue,
  inputMode,
  hint,
  invalid,
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  inputMode: "decimal" | "numeric" | "text";
  hint?: string;
  invalid?: boolean;
  maxLength?: number;
}) {
  const hintId = useId();
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <Input
        type="text"
        name={name}
        defaultValue={defaultValue}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? hintId : undefined}
      />
      {hint && (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

function CurrencySelect({ label, name, defaultValue, invalid }: { label: string; name: string; defaultValue: Currency; invalid?: boolean }) {
  const t = useTranslations("payments.plans");
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue} aria-invalid={invalid || undefined} className={`${FIELD_CLASS} ${INVALID_SELECT}`}>
        {CURRENCIES.map((currency) => (
          <option key={currency} value={currency}>
            {t(`currencyOption.${currency}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Month as a name list and the year as digits, so the owner never types a month number. */
function MonthFields({ defaults, invalid }: { defaults: MonthDefaults; invalid?: boolean }) {
  const t = useTranslations("payments.plans.dues.fields");
  const locale = useLocale();
  const names = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, index, 1))),
  );
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t("effectiveMonth")}</span>
        <select name="effectiveMonth" defaultValue={String(defaults.month)} aria-invalid={invalid || undefined} className={`${FIELD_CLASS} ${INVALID_SELECT}`}>
          {names.map((name, index) => (
            <option key={name} value={String(index + 1)}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <TextField label={t("effectiveYear")} name="effectiveYear" defaultValue={String(defaults.year)} inputMode="numeric" maxLength={4} invalid={invalid} />
    </>
  );
}

function Outcome({ state, success }: { state: ActionState; success: string }) {
  const t = useTranslations("payments.plans.dues.error");
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-bad">
        {t(state.error as never)}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="text-sm text-ok">
        {success}
      </p>
    );
  }
  return null;
}

function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{summary}</summary>
      <div className="flex flex-col gap-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

const FIELD_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4";

/** Add a price (a terms version) to a plan. A monthly plan always covers one month; a package plan names its own length. */
export function AddTermsForm({
  organizationId,
  planId,
  isPackage,
  defaults,
  defaultCurrency,
}: {
  organizationId: string;
  planId: string;
  isPackage: boolean;
  defaults: MonthDefaults;
  defaultCurrency: Currency;
}) {
  const t = useTranslations("payments.plans.dues");
  const { state, onSubmit, isPending } = useDuesAction(addPlanTerms.bind(null, organizationId));
  const bad = (field: string) => Boolean(state.fieldErrors?.[field]);
  return (
    <Disclosure summary={t("terms.add.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="planId" value={planId} />
        <div className={FIELD_GRID}>
          <MonthFields defaults={defaults} invalid={bad("effectiveMonth")} />
          <TextField label={t("fields.price")} name="priceAmount" inputMode="decimal" invalid={bad("priceAmount")} />
          <CurrencySelect label={t("fields.currency")} name="currency" defaultValue={defaultCurrency} invalid={bad("currency")} />
          {isPackage ? (
            <TextField label={t("fields.monthsCovered")} name="monthsCovered" inputMode="numeric" invalid={bad("monthsCovered")} />
          ) : (
            <input type="hidden" name="monthsCovered" value="1" />
          )}
        </div>
        <Outcome state={state} success={t("terms.add.success")} />
        <div>
          <Button type="submit" disabled={isPending}>
            {t("terms.add.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

export interface TermsRowData {
  id: string;
  revision: string;
  priceAmount: string;
  currency: Currency;
  monthsCovered: number;
}

/** Correct a terms version whose month has not started. The revision token makes a stale edit fail instead of overwriting. */
export function CorrectTermsForm({ organizationId, row }: { organizationId: string; row: TermsRowData }) {
  const t = useTranslations("payments.plans.dues");
  const { state, onSubmit, isPending } = useDuesAction(correctPlanTerms.bind(null, organizationId));
  const bad = (field: string) => Boolean(state.fieldErrors?.[field]);
  return (
    // Remounts with fresh defaults once a saved correction changes the row's revision.
    <Disclosure key={row.revision} summary={t("terms.correct.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="termsId" value={row.id} />
        <input type="hidden" name="expectedRevision" value={row.revision} />
        <div className={FIELD_GRID}>
          <TextField label={t("fields.price")} name="priceAmount" defaultValue={row.priceAmount} inputMode="decimal" invalid={bad("priceAmount")} />
          <CurrencySelect label={t("fields.currency")} name="currency" defaultValue={row.currency} invalid={bad("currency")} />
          {row.monthsCovered > 1 ? (
            <TextField label={t("fields.monthsCovered")} name="monthsCovered" defaultValue={String(row.monthsCovered)} inputMode="numeric" invalid={bad("monthsCovered")} />
          ) : (
            <input type="hidden" name="monthsCovered" value="1" />
          )}
        </div>
        <Outcome state={state} success={t("terms.correct.success")} />
        <div>
          <Button type="submit" disabled={isPending}>
            {t("terms.correct.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

/** A new package plan: the plan and its first price in one save. */
export function CreatePackageForm({
  organizationId,
  academyId,
  defaults,
  defaultCurrency,
}: {
  organizationId: string;
  academyId: string;
  defaults: MonthDefaults;
  defaultCurrency: Currency;
}) {
  const t = useTranslations("payments.plans.dues");
  const { state, onSubmit, isPending } = useDuesAction(createPackagePlan.bind(null, organizationId));
  const bad = (field: string) => Boolean(state.fieldErrors?.[field]);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("newPackage.heading")}</p>
      <p className="text-xs text-muted-foreground">{t("newPackage.body")}</p>
      <input type="hidden" name="academyId" value={academyId} />
      <div className={FIELD_GRID}>
        <TextField label={t("fields.packageName")} name="name" inputMode="text" maxLength={80} invalid={bad("name")} />
        <TextField label={t("fields.description")} name="description" inputMode="text" maxLength={200} invalid={bad("description")} />
        <TextField label={t("fields.monthsCovered")} name="monthsCovered" inputMode="numeric" invalid={bad("monthsCovered")} />
        <TextField label={t("fields.price")} name="priceAmount" inputMode="decimal" invalid={bad("priceAmount")} />
        <CurrencySelect label={t("fields.currency")} name="currency" defaultValue={defaultCurrency} invalid={bad("currency")} />
        <MonthFields defaults={defaults} invalid={bad("effectiveMonth")} />
      </div>
      <Outcome state={state} success={t("newPackage.success")} />
      <div>
        <Button type="submit" disabled={isPending}>
          {t("newPackage.submit")}
        </Button>
      </div>
    </form>
  );
}

function PolicyFields({
  values,
  bad,
  defaultCurrency,
}: {
  values?: { dueDay: string; graceDay: string; lateFeeAmount: string; lateFeeCurrency: Currency; maxPrepaidMonths: string };
  bad: (field: string) => boolean;
  defaultCurrency: Currency;
}) {
  const t = useTranslations("payments.plans.dues");
  return (
    <>
      <TextField label={t("fields.dueDay")} name="dueDay" defaultValue={values?.dueDay} inputMode="numeric" maxLength={2} invalid={bad("dueDay")} />
      <TextField
        label={t("fields.graceDay")}
        name="graceDay"
        defaultValue={values?.graceDay}
        inputMode="numeric"
        maxLength={2}
        hint={t("policy.graceHint")}
        invalid={bad("graceDay")}
      />
      <TextField label={t("fields.lateFee")} name="lateFeeAmount" defaultValue={values?.lateFeeAmount} inputMode="decimal" invalid={bad("lateFeeAmount")} />
      <CurrencySelect label={t("fields.lateFeeCurrency")} name="lateFeeCurrency" defaultValue={values?.lateFeeCurrency ?? defaultCurrency} invalid={bad("lateFeeCurrency")} />
      <TextField
        label={t("fields.maxPrepaidMonths")}
        name="maxPrepaidMonths"
        defaultValue={values?.maxPrepaidMonths}
        inputMode="numeric"
        hint={t("policy.limitHint")}
        invalid={bad("maxPrepaidMonths")}
      />
    </>
  );
}

/** Add a dues policy version (due day, grace day, late fee, prepayment limit) to a location. */
export function AddPolicyForm({
  organizationId,
  academyId,
  defaults,
  defaultCurrency,
}: {
  organizationId: string;
  academyId: string;
  defaults: MonthDefaults;
  defaultCurrency: Currency;
}) {
  const t = useTranslations("payments.plans.dues");
  const { state, onSubmit, isPending } = useDuesAction(addPolicyVersion.bind(null, organizationId));
  const bad = (field: string) => Boolean(state.fieldErrors?.[field]);
  return (
    <Disclosure summary={t("policy.add.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="academyId" value={academyId} />
        <div className={FIELD_GRID}>
          <MonthFields defaults={defaults} invalid={bad("effectiveMonth")} />
          <PolicyFields bad={bad} defaultCurrency={defaultCurrency} />
        </div>
        <Outcome state={state} success={t("policy.add.success")} />
        <div>
          <Button type="submit" disabled={isPending}>
            {t("policy.add.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

export interface PolicyRowData {
  id: string;
  revision: string;
  dueDay: string;
  graceDay: string;
  lateFeeAmount: string;
  lateFeeCurrency: Currency;
  maxPrepaidMonths: string;
}

/** Correct a policy version whose month has not started. */
export function CorrectPolicyForm({ organizationId, row }: { organizationId: string; row: PolicyRowData }) {
  const t = useTranslations("payments.plans.dues");
  const { state, onSubmit, isPending } = useDuesAction(correctPolicyVersion.bind(null, organizationId));
  const bad = (field: string) => Boolean(state.fieldErrors?.[field]);
  return (
    <Disclosure key={row.revision} summary={t("policy.correct.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="policyId" value={row.id} />
        <input type="hidden" name="expectedRevision" value={row.revision} />
        <div className={FIELD_GRID}>
          <PolicyFields values={row} bad={bad} defaultCurrency={row.lateFeeCurrency} />
        </div>
        <Outcome state={state} success={t("policy.correct.success")} />
        <div>
          <Button type="submit" disabled={isPending}>
            {t("policy.correct.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
