"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { recordPayment } from "./payment-actions";
import { PaymentStatus } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const STATUS_OPTIONS = Object.values(PaymentStatus);
const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

type Plan = { id: string; name: string };

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx's `canEdit` gate,
// matching how edit/archive are gated) — the real enforcement is
// server-side in `recordPayment` itself (requireStaffSession(["ADMIN",
// "DIRECTOR"]) + a fresh isAcademyInScope + plan-academy cross-check), never
// this UI alone. `plans` is already scoped to the student's own
// `homeAcademyId` by the caller (page.tsx) — this form never lets a
// director pick a plan from the other academy.
export function RecordPaymentForm({
  studentId,
  plans,
  defaultYear,
  defaultMonth,
}: {
  studentId: string;
  plans: Plan[];
  defaultYear: number;
  defaultMonth: number;
}) {
  const t = useTranslations("students.detail.recordPayment");
  const tPaymentStatus = useTranslations("students.paymentStatus");
  const [state, formAction, isPending] = useActionState(recordPayment, INITIAL_STATE);

  // `amount` and `notes` are optional, but a plain HTML `<input>`/`<textarea>`
  // always submits its name with an empty-string value when left blank — it
  // is never simply ABSENT from the FormData. Task 1's zod schema
  // (`z.coerce.number().min(0).optional()`) coerces that `""` to `0` rather
  // than `undefined` (Number("") === 0), which would silently record a real
  // $0 payment instead of leaving the amount unspecified; `notes: ""` would
  // likewise store an empty string instead of `null`, breaking the `??
  // "—"` fallback used everywhere else in this UI. Stripping empty values
  // here, before the action ever sees them, keeps that schema untouched and
  // correct for every other caller.
  function submitWithEmptyOptionalFieldsStripped(formData: FormData) {
    for (const field of ["amount", "notes"] as const) {
      const value = formData.get(field);
      if (typeof value === "string" && value.trim() === "") {
        formData.delete(field);
      }
    }
    return formAction(formData);
  }

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && <p className="mt-4 text-sm text-green-700">{t("success")}</p>}

      <form
        action={submitWithEmptyOptionalFieldsStripped}
        className="mt-4 flex w-full max-w-sm flex-col gap-3"
      >
        <input type="hidden" name="studentId" value={studentId} />

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span>{t("year")}</span>
            <input
              type="number"
              name="year"
              required
              min={2020}
              max={2100}
              defaultValue={defaultYear}
              className="rounded border px-3 py-2"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span>{t("month")}</span>
            <select name="month" required defaultValue={defaultMonth} className="rounded border px-3 py-2">
              {MONTH_OPTIONS.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span>{t("plan")}</span>
          <select name="planId" required defaultValue="" className="rounded border px-3 py-2">
            <option value="" disabled>
              {t("planPlaceholder")}
            </option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("status")}</span>
          <select
            name="status"
            required
            defaultValue={PaymentStatus.PAID}
            className="rounded border px-3 py-2"
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {tPaymentStatus(status)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("amount")}</span>
          <input type="number" name="amount" min={0} step="0.01" className="rounded border px-3 py-2" />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notes")}</span>
          <textarea name="notes" className="rounded border px-3 py-2" />
        </label>

        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
