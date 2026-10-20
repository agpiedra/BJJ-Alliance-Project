"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { createOpeningDraft, replaceOpeningDraft, withdrawOpeningDraft } from "@/lib/dues/readiness/opening-actions";
import { AmountField, ConfirmDialog, CurrencyRadios, focusFirstInvalid, MonthYearFields, TextAreaField, type FieldErrors } from "./form-fields";
import { useScopedSubmit } from "./use-readiness-action";

/**
 * Stage 8d-2 (plan §3.3): the owner's opening-debt draft forms, calling the 8c actions unchanged. Replace and withdraw never edit
 * in place: the action marks the old draft and (for replace) inserts a successor, so history is kept. Every id here came from the
 * server-rendered read model; the server re-reads every reference in this organization.
 */

export type DraftView = { id: string; coverageYear: number; coverageMonth: number; amount: string; currency: string; note: string; legacyPaymentPeriodId: string | null; label: string };
export type LegacyOption = { id: string; label: string };

function LegacyLinkSelect({ options, defaultValue, errors }: { options: readonly LegacyOption[]; defaultValue?: string | null; errors: FieldErrors }) {
  const t = useTranslations("payments.readiness.forms");
  const invalid = Boolean(errors.legacyPaymentPeriodId);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{t("fields.legacyLink")}</span>
      <select
        name="legacyPaymentPeriodId"
        defaultValue={defaultValue ?? ""}
        aria-invalid={invalid || undefined}
        className={`${FIELD_CLASS} min-w-0 aria-invalid:border-2 aria-invalid:border-destructive`}
      >
        <option value="">{t("fields.legacyNone")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted-foreground">{t("fields.legacyHint")}</span>
      {invalid && <span className="text-xs text-bad">{t(errors.legacyPaymentPeriodId?.[0] === "mismatch" ? "field.linkMismatch" : "field.legacyPaymentPeriodId")}</span>}
    </label>
  );
}

function DraftFields({ draft, legacyOptions, errors, monthLegend }: { draft?: DraftView; legacyOptions: readonly LegacyOption[]; errors: FieldErrors; monthLegend: string }) {
  const t = useTranslations("payments.readiness.forms.fields");
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <MonthYearFields
        yearName="coverageYear"
        monthName="coverageMonth"
        legend={monthLegend}
        defaults={draft ? { year: draft.coverageYear, month: draft.coverageMonth } : undefined}
        errors={errors}
        errorField="coverageMonth"
      />
      <AmountField defaultValue={draft?.amount} errors={errors} />
      <CurrencyRadios defaultValue={draft?.currency} errors={errors} />
      <LegacyLinkSelect options={legacyOptions} defaultValue={draft?.legacyPaymentPeriodId} errors={errors} />
      <div className="md:col-span-2">
        <TextAreaField name="note" label={t("note")} defaultValue={draft?.note} errors={errors} />
      </div>
    </div>
  );
}

export function AddDraftForm({ organizationId, studentId, legacyOptions, monthLegend }: { organizationId: string; studentId: string; legacyOptions: readonly LegacyOption[]; monthLegend: string }) {
  const t = useTranslations("payments.readiness.forms.drafts");
  const { submit, pending, locked, fieldErrors } = useScopedSubmit(`student:${studentId}`, "card");
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("add")}</summary>
      <form
        className="flex flex-col gap-3 border-t border-border p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const errors = await submit((fd) => createOpeningDraft(organizationId, {}, fd), new FormData(form), { onSaved: () => form.reset() });
          if (Object.keys(errors).length > 0) focusFirstInvalid(form);
        }}
      >
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
          <input type="hidden" name="studentId" value={studentId} />
          <DraftFields legacyOptions={legacyOptions} errors={fieldErrors} monthLegend={monthLegend} />
          <div>
            <Button type="submit" aria-busy={pending || undefined}>
              {t("addSubmit")}
            </Button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}

export function ReplaceDraftForm({ organizationId, studentId, draft, legacyOptions, monthLegend }: { organizationId: string; studentId: string; draft: DraftView; legacyOptions: readonly LegacyOption[]; monthLegend: string }) {
  const t = useTranslations("payments.readiness.forms.drafts");
  const { submit, pending, locked, fieldErrors } = useScopedSubmit(`student:${studentId}`, "card");
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("replace")}</summary>
      <form
        className="flex flex-col gap-3 border-t border-border p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const errors = await submit((fd) => replaceOpeningDraft(organizationId, {}, fd), new FormData(form), { targetId: draft.id });
          if (Object.keys(errors).length > 0) focusFirstInvalid(form);
        }}
      >
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
          <input type="hidden" name="draftId" value={draft.id} />
          <p className="text-xs text-muted-foreground">{t("replaceHint")}</p>
          <DraftFields draft={draft} legacyOptions={legacyOptions} errors={fieldErrors} monthLegend={monthLegend} />
          <div>
            <Button type="submit" aria-busy={pending || undefined}>
              {t("replaceSubmit")}
            </Button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}

export function WithdrawDraftButton({ organizationId, studentId, draft }: { organizationId: string; studentId: string; draft: DraftView }) {
  const t = useTranslations("payments.readiness.forms.drafts");
  const { submit, pending, locked, fieldErrors } = useScopedSubmit(`student:${studentId}`, "card");
  const [open, setOpen] = useState(false);
  // Kept in state, so a reason typed before an unknown outcome is still there if the dialog is opened again.
  const [reason, setReason] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const invalid = Boolean(fieldErrors.reason);
  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={locked} onClick={() => setOpen(true)}>
        {t("withdraw")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("withdrawTitle")}
        confirmLabel={t("withdrawSubmit")}
        pending={pending}
        initialFocus={reasonRef}
        finalFocus={triggerRef}
        onConfirm={async () => {
          const fd = new FormData();
          fd.set("draftId", draft.id);
          fd.set("reason", reason);
          const errors = await submit((data) => withdrawOpeningDraft(organizationId, {}, data), fd, { targetId: draft.id });
          if (Object.keys(errors).length === 0) setOpen(false);
          else reasonRef.current?.focus();
        }}
      >
        <p>{t("withdrawBody", { draft: draft.label })}</p>
        <label className="flex flex-col gap-1 text-sm text-foreground">
          <span>{t("reason")}</span>
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            aria-invalid={invalid || undefined}
            className={`${FIELD_CLASS} h-auto min-h-16 py-2 aria-invalid:border-2 aria-invalid:border-destructive`}
          />
          {invalid && <span className="text-xs text-bad">{t("reasonInvalid")}</span>}
        </label>
      </ConfirmDialog>
    </>
  );
}
