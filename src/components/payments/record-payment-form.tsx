"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { recordPayment } from "@/lib/payments/payment-actions";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";
import { PaymentMethod, PaymentStatus } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const STATUS_OPTIONS = Object.values(PaymentStatus);
const METHOD_OPTIONS = Object.values(PaymentMethod);

export interface RecordPaymentStudentOption {
  id: string;
  firstName: string;
  lastName: string;
  academyId: string;
  academyName: string;
}

export interface RecordPaymentPlanOption {
  id: string;
  name: string;
  academyId: string;
}

export interface RecordPaymentDefaults {
  /** `"YYYY-MM"` — the exact format `<input type="month">` uses. */
  month: string;
  planId?: string;
  status?: PaymentStatus;
  amount?: number | null;
  method?: PaymentMethod | null;
  notes?: string | null;
  promoName?: string | null;
  promoReason?: string | null;
  promoRecurring?: boolean;
}

export interface RecordPaymentFormProps {
  /** Every student the caller may pick from. The student-detail page passes
   * a single-item list (that student only); the /payments page passes every
   * active student in the session's academy scope. */
  students: RecordPaymentStudentOption[];
  /** Every plan across every academy the caller's `students` cover,
   * including the seeded custom-promo row (`ensureCustomPromoPlan`) — this
   * component filters the Plan `<select>` to the CURRENTLY selected
   * student's own academy client-side, never trusting the server to have
   * pre-scoped it (the real scope check is still `recordPayment`'s own
   * plan-academy cross-check). */
  plans: RecordPaymentPlanOption[];
  /** Student-detail page usage: pre-selects and locks the Alumno field to
   * this one student instead of rendering a picker — same UX the form has
   * always had there. Omitted on the /payments page, where Alumno is a real
   * choice. */
  lockedStudentId?: string;
  /** REDESIGN_BRIEF.md §6.3 role gate: only ADMIN/DIRECTOR ever see the
   * custom-promotion sub-panel. An INSTRUCTOR session that somehow reaches
   * this component with the custom-promo plan selected sees the
   * "ask the director" hint instead — the real enforcement is
   * `recordPayment`'s own ADMIN/DIRECTOR-only gate, this is UI-only. */
  canManagePromotions: boolean;
  defaults: RecordPaymentDefaults;
  /** Edit-in-a-Sheet usage (Pagos table's "Editar" on a promo row): closes
   * the sheet once the save succeeds. */
  onSuccess?: () => void;
  onCancel?: () => void;
}

/**
 * Shared by both the student-detail page (single locked student) and the
 * new `/payments` route (full picker) — REDESIGN_BRIEF.md §6.1's "render the
 * same component in both places," not two forks of the same form.
 */
export function RecordPaymentForm({
  students,
  plans,
  lockedStudentId,
  canManagePromotions,
  defaults,
  onSuccess,
  onCancel,
}: RecordPaymentFormProps) {
  const t = useTranslations("students.detail.recordPayment");
  const tPaymentStatus = useTranslations("students.paymentStatus");
  const tMethod = useTranslations("payments.method");
  const [state, formAction, isPending] = useActionState(recordPayment, INITIAL_STATE);

  // Deliberately NOT `?? students[0]?.id` on the unscoped `/payments` page:
  // pre-selecting the alphabetically-first student would make the
  // placeholder option unreachable and `required` a no-op — a director who
  // fills in amount/method/status without ever touching Alumno would
  // silently record a real payment against the wrong person. The field
  // must start genuinely empty so a real choice is forced.
  const [selectedStudentId, setSelectedStudentId] = useState(lockedStudentId ?? "");
  const [selectedPlanId, setSelectedPlanId] = useState(defaults.planId ?? "");

  useEffect(() => {
    if (state.ok) onSuccess?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok]);

  const selectedStudent = students.find((s) => s.id === selectedStudentId);
  const plansForAcademy = useMemo(
    () => (selectedStudent ? plans.filter((p) => p.academyId === selectedStudent.academyId) : []),
    [plans, selectedStudent],
  );
  const selectedPlan = plansForAcademy.find((p) => p.id === selectedPlanId);
  const isCustomPromoPlan = selectedPlan?.name === CUSTOM_PROMO_PLAN_NAME;

  // `amount`/`notes`/`promoName`/`promoReason` are optional, but a plain
  // HTML <input> always submits its name with an empty-string value when
  // left blank — it is never simply ABSENT from the FormData. The server
  // schema coerces a genuinely blank field to "unspecified" only when the
  // key is truly missing (Number("") === 0 / "" !== undefined otherwise),
  // so blank optional fields are stripped here before submission, same
  // established fix as this form always had for amount/notes.
  //
  // The month `<input type="month">` submits `"YYYY-MM"` under the name
  // `period` — split into the separate `year`/`month` fields `recordPayment`
  // has always accepted, so the server action's contract (and its existing
  // tests) never had to change for this UI-only switch to a native month
  // picker.
  function submitWithAdjustedFields(formData: FormData) {
    const period = formData.get("period");
    if (typeof period === "string" && /^\d{4}-\d{2}$/.test(period)) {
      const [year, month] = period.split("-");
      formData.set("year", year);
      formData.set("month", String(Number(month)));
    }
    formData.delete("period");

    for (const field of ["amount", "notes", "promoName", "promoReason"] as const) {
      const value = formData.get(field);
      if (typeof value === "string" && value.trim() === "") {
        formData.delete(field);
      }
    }
    // An unchecked checkbox never appears in FormData at all — nothing to
    // strip there, `recordPayment`'s schema already treats "absent" as false.

    return formAction(formData);
  }

  return (
    <form action={submitWithAdjustedFields} className="flex flex-col gap-4">
      {lockedStudentId && <input type="hidden" name="studentId" value={lockedStudentId} />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {!lockedStudentId && (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("student")}</span>
            <select
              name="studentId"
              required
              value={selectedStudentId}
              onChange={(e) => setSelectedStudentId(e.target.value)}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="" disabled>
                {t("studentPlaceholder")}
              </option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.firstName} {student.lastName} — {student.academyName}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span>{t("plan")}</span>
          <select
            name="planId"
            required
            value={selectedPlanId}
            onChange={(e) => setSelectedPlanId(e.target.value)}
            className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="" disabled>
              {t("planPlaceholder")}
            </option>
            {plansForAcademy.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>{t("period")}</span>
          <input
            type="month"
            name="period"
            required
            defaultValue={defaults.month}
            className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>{t("method")}</span>
          <select
            name="method"
            defaultValue={defaults.method ?? ""}
            className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">{t("methodPlaceholder")}</option>
            {METHOD_OPTIONS.map((method) => (
              <option key={method} value={method}>
                {tMethod(method)}
              </option>
            ))}
          </select>
        </label>

        {/* Custom-promo plans carry their own "Monto acordado" field inside
            the sub-panel below (same `amount` FormData key) — showing both
            would be two inputs writing the same column. */}
        {!isCustomPromoPlan && (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("amount")}</span>
            <input
              type="number"
              name="amount"
              min={0}
              step="0.01"
              defaultValue={defaults.amount ?? undefined}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span>{t("status")}</span>
          <select
            name="status"
            required
            defaultValue={defaults.status ?? PaymentStatus.PAID}
            className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {tPaymentStatus(status)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span>{t("notes")}</span>
          <input
            type="text"
            name="notes"
            defaultValue={defaults.notes ?? undefined}
            className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          />
        </label>
      </div>

      {isCustomPromoPlan && canManagePromotions && (
        <div className="flex flex-col gap-3 rounded-lg border border-brand-gold/30 bg-brand-gold/15 p-4">
          <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
            {t("promo.heading")}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("promo.name")}</span>
              <input
                type="text"
                name="promoName"
                required
                placeholder={t("promo.namePlaceholder")}
                defaultValue={defaults.promoName ?? undefined}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("promo.amount")}</span>
              <input
                type="number"
                name="amount"
                min={0}
                step="0.01"
                placeholder={t("promo.amountPlaceholder")}
                defaultValue={defaults.amount ?? undefined}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span>{t("promo.reason")}</span>
              <input
                type="text"
                name="promoReason"
                placeholder={t("promo.reasonPlaceholder")}
                defaultValue={defaults.promoReason ?? undefined}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="promoRecurring"
                defaultChecked={defaults.promoRecurring ?? false}
              />
              {t("promo.recurring")}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t("promo.note")}</p>
        </div>
      )}

      {isCustomPromoPlan && !canManagePromotions && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          {t("promo.instructorHint")}
        </p>
      )}

      {state.error && <p className="text-sm text-bad">{t(state.error)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("success")}</p>}

      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">{t("footerHint")}</span>
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
