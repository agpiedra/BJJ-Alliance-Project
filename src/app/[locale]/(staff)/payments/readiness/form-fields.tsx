"use client";

import { useId, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertDialog, AlertDialogActions, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { CURRENCIES } from "@/lib/payments/format-money";
import { fieldErrorKey } from "./outcome-messages";

/**
 * Stage 8d-2 field controls. Client attributes (`required`, `maxLength`, `inputMode`) are conveniences only: the server parses
 * every field and its refusal is always shown here. Amounts are text, sent exactly as typed (never parsed into a number here).
 */

const INVALID = "aria-invalid:border-2 aria-invalid:border-destructive";

export type FieldErrors = Record<string, string[]>;

function ErrorText({ id, errors, field }: { id: string; errors: FieldErrors; field: string }) {
  const t = useTranslations("payments.readiness.forms");
  const reason = errors[field]?.[0];
  if (!reason) return null;
  return (
    <span id={id} className="text-xs text-bad">
      {t(fieldErrorKey(field, reason) as never)}
    </span>
  );
}

/** A month (names) and a year (digits) under the action's own field names. */
export function MonthYearFields({ yearName, monthName, legend, defaults, errors, errorField }: {
  yearName: string;
  monthName: string;
  legend: string;
  defaults?: { year: number; month: number };
  errors: FieldErrors;
  errorField: string;
}) {
  const t = useTranslations("payments.readiness.forms.fields");
  const locale = useLocale();
  const errorId = useId();
  const invalid = Boolean(errors[errorField]);
  const names = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, index, 1))),
  );
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-sm">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          <span>{t("month")}</span>
          <select
            name={monthName}
            required
            defaultValue={defaults ? String(defaults.month) : ""}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            className={`${FIELD_CLASS} ${INVALID} min-w-0 text-foreground`}
          >
            {!defaults && <option value="">{t("choose")}</option>}
            {names.map((name, index) => (
              <option key={name} value={String(index + 1)}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-24 flex-col gap-1 text-xs text-muted-foreground">
          <span>{t("year")}</span>
          <Input
            type="text"
            name={yearName}
            required
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
            defaultValue={defaults ? String(defaults.year) : ""}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
          />
        </label>
      </div>
      <ErrorText id={errorId} errors={errors} field={errorField} />
    </fieldset>
  );
}

export function AmountField({ defaultValue, errors }: { defaultValue?: string; errors: FieldErrors }) {
  const t = useTranslations("payments.readiness.forms.fields");
  const hintId = useId();
  const errorId = useId();
  const invalid = Boolean(errors.amount);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{t("amount")}</span>
      <Input
        type="text"
        name="amount"
        required
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        defaultValue={defaultValue}
        aria-invalid={invalid || undefined}
        aria-describedby={`${hintId}${invalid ? ` ${errorId}` : ""}`}
      />
      <span id={hintId} className="text-xs text-muted-foreground">
        {t("amountHint")}
      </span>
      <ErrorText id={errorId} errors={errors} field="amount" />
    </label>
  );
}

/** A required currency choice with NO default for a new draft: the owner must pick one (plan §3.3). */
export function CurrencyRadios({ defaultValue, errors }: { defaultValue?: string; errors: FieldErrors }) {
  const t = useTranslations("payments.readiness.forms.fields");
  const errorId = useId();
  const invalid = Boolean(errors.currency);
  return (
    <fieldset className="flex flex-col gap-1" aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}>
      <legend className="text-sm">{t("currency")}</legend>
      <div className="flex flex-wrap gap-4">
        {CURRENCIES.map((currency) => (
          <label key={currency} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <input type="radio" name="currency" value={currency} required defaultChecked={defaultValue === currency} className="size-4" />
            {currency}
          </label>
        ))}
      </div>
      <ErrorText id={errorId} errors={errors} field="currency" />
    </fieldset>
  );
}

export function TextAreaField({ name, label, defaultValue, errors }: { name: string; label: string; defaultValue?: string; errors: FieldErrors }) {
  const t = useTranslations("payments.readiness.forms.fields");
  const hintId = useId();
  const errorId = useId();
  const invalid = Boolean(errors[name]);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <textarea
        name={name}
        required
        maxLength={500}
        rows={2}
        defaultValue={defaultValue}
        aria-invalid={invalid || undefined}
        aria-describedby={`${hintId}${invalid ? ` ${errorId}` : ""}`}
        className={`${FIELD_CLASS} ${INVALID} h-auto min-h-16 py-2`}
      />
      <span id={hintId} className="text-xs text-muted-foreground">
        {t("textHint")}
      </span>
      <ErrorText id={errorId} errors={errors} field={name} />
    </label>
  );
}

/**
 * An attestation or irreversible-step dialog. Focus starts on Cancel (plan §5) unless `initialFocus` names a field, and returns to
 * the trigger on close (Base UI). Dismissal is blocked while the request is pending.
 */
export function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, onConfirm, pending, initialFocus, finalFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("payments.readiness.forms");
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={(next) => (!next && pending ? undefined : onOpenChange(next))}>
      <AlertDialogPopup initialFocus={initialFocus ?? cancelRef} finalFocus={finalFocus} className="max-h-[85dvh] max-w-md overflow-y-auto">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <div className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>
        <AlertDialogActions>
          <Button ref={cancelRef} type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" disabled={pending} aria-busy={pending || undefined} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogActions>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Moves focus to the first field the server refused. The submit disabled the form while pending (so the focused button lost focus),
 * and the refused field is re-enabled and marked only on a later render: retry for a few frames until it is there and enabled.
 */
export function focusFirstInvalid(form: HTMLFormElement | null) {
  let frames = 0;
  const attempt = () => {
    const field = form?.querySelector<HTMLInputElement>('[aria-invalid="true"] input, [aria-invalid="true"]:not(fieldset)');
    if (field && !field.disabled && !field.closest("fieldset:disabled")) {
      field.focus();
      return;
    }
    if (frames++ < 30) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
