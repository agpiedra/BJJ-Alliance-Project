"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { runStatusHistoryBaseline } from "@/lib/students/baseline-action";
import { assignPlan, correctAssignment } from "@/lib/dues/assignment-actions";
import { ConfirmDialog, focusFirstInvalid, MonthYearFields } from "./form-fields";
import { ScopeStatus, useScopedSubmit } from "./use-readiness-action";

/**
 * Stage 8d-2 (plan §3.1, §3.2): before S — the status baseline and plan assignments, calling the existing actions unchanged.
 *
 * Baseline (D2): organization-wide, dated today in each branch, idempotent. The server takes no confirmation; the dialog is the
 * owner's only warning, and it leads with every branch where a baseline taken today can no longer satisfy check 1 for S. The
 * button stays available there (it is still correct history).
 *
 * Assignment (D1): `assignPlan` reads an absent or empty `planId` as an explicit "no plan". The radio group therefore has no
 * preselection and "No plan" needs its own dialog; this is a convenience only, the server cannot tell omission from choice.
 */

export function BaselineControl({ organizationId, total, active, cannotHelp, allCannotHelp, candidateLabel }: {
  organizationId: string;
  total: number;
  active: number;
  /** Branch names where today is on or after the 1st of S. */
  cannotHelp: readonly string[];
  allCannotHelp: boolean;
  candidateLabel: string;
}) {
  const t = useTranslations("payments.readiness.forms.baseline");
  const { submit, pending, locked } = useScopedSubmit("baseline", "baseline");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{t("count", { total, active })}</p>
      <div>
        <Button ref={triggerRef} type="button" variant="outline" disabled={locked} onClick={() => setOpen(true)}>
          {t("open")}
        </Button>
      </div>
      <ScopeStatus scope="baseline" place="baseline" />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dialogTitle")}
        confirmLabel={t("submit")}
        pending={pending}
        finalFocus={triggerRef}
        onConfirm={async () => {
          await submit((fd) => runStatusHistoryBaseline(organizationId, {}, fd), new FormData());
          setOpen(false);
        }}
      >
        {cannotHelp.length > 0 && (
          <div className="rounded-md border border-warn-line bg-warn-soft p-2 text-foreground">
            <p className="font-medium">{allCannotHelp ? t("cannotHelpAll", { month: candidateLabel }) : t("cannotHelpSome", { month: candidateLabel })}</p>
            <ul className="list-disc pl-5">
              {cannotHelp.map((name, index) => (
                <li key={index} className="break-words">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p>{t("body")}</p>
        <p>{t("staleNote")}</p>
      </ConfirmDialog>
    </div>
  );
}

export type PlanOption = { id: string; label: string };

function PlanRadios({ plans, defaultValue, invalid }: { plans: readonly PlanOption[]; defaultValue?: string | null; invalid: boolean }) {
  const t = useTranslations("payments.readiness.forms.assignment");
  return (
    <fieldset className="flex min-w-0 flex-col gap-1" aria-invalid={invalid || undefined}>
      <legend className="text-sm">{t("plan")}</legend>
      {plans.map((p) => (
        <label key={p.id} className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0">
          <input type="radio" name="planId" value={p.id} required defaultChecked={defaultValue === p.id} className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{p.label}</span>
        </label>
      ))}
      <label className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0">
        <input type="radio" name="planId" value="" required defaultChecked={defaultValue === null} className="mt-0.5 size-4 shrink-0" />
        <span>{t("noPlan")}</span>
      </label>
      {plans.length === 0 && <span className="text-xs text-muted-foreground">{t("noPlans")}</span>}
      {invalid && <span className="text-xs text-bad">{t("planInvalid")}</span>}
    </fieldset>
  );
}

/** Submits the form, first confirming an explicit "No plan" in its own dialog. */
function useNoPlanGuard() {
  const [pendingNoPlan, setPendingNoPlan] = useState<HTMLFormElement | null>(null);
  const intercept = (form: HTMLFormElement, go: (form: HTMLFormElement) => void) => {
    if (new FormData(form).get("planId") === "") setPendingNoPlan(form);
    else go(form);
  };
  return { pendingNoPlan, setPendingNoPlan, intercept };
}

export function AssignPlanForm({ organizationId, studentId, studentName, plans, defaultMonth, monthLegend }: {
  organizationId: string;
  studentId: string;
  studentName: string;
  plans: readonly PlanOption[];
  defaultMonth: { year: number; month: number };
  monthLegend: string;
}) {
  const t = useTranslations("payments.readiness.forms.assignment");
  const { submit, pending, locked, fieldErrors } = useScopedSubmit(`student:${studentId}`, "assignment");
  const guard = useNoPlanGuard();
  const go = async (form: HTMLFormElement) => {
    const errors = await submit((fd) => assignPlan(organizationId, {}, fd), new FormData(form), { onSaved: () => form.reset() });
    if (Object.keys(errors).length > 0) focusFirstInvalid(form);
  };
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("assign")}</summary>
      <form
        className="flex flex-col gap-3 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          guard.intercept(event.currentTarget, go);
        }}
      >
        <fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
          <input type="hidden" name="studentId" value={studentId} />
          <MonthYearFields yearName="effectiveYear" monthName="effectiveMonth" legend={monthLegend} defaults={defaultMonth} errors={fieldErrors} errorField="effectiveMonth" />
          <PlanRadios plans={plans} invalid={Boolean(fieldErrors.planId)} />
          <div className="md:col-span-2">
            <Button type="submit" aria-busy={pending || undefined}>
              {t("assignSubmit")}
            </Button>
          </div>
        </fieldset>
      </form>
      <NoPlanDialog studentName={studentName} guard={guard} pending={pending} onConfirm={go} />
    </details>
  );
}

export function CorrectAssignmentForm({ organizationId, studentId, studentName, assignment, plans, monthLabel }: {
  organizationId: string;
  studentId: string;
  studentName: string;
  assignment: { id: string; planId: string | null; revision: string };
  plans: readonly PlanOption[];
  monthLabel: string;
}) {
  const t = useTranslations("payments.readiness.forms.assignment");
  const { submit, pending, locked, fieldErrors } = useScopedSubmit(`student:${studentId}`, "assignment");
  const guard = useNoPlanGuard();
  const go = async (form: HTMLFormElement) => {
    const errors = await submit((fd) => correctAssignment(organizationId, {}, fd), new FormData(form), { targetId: assignment.id });
    if (Object.keys(errors).length > 0) focusFirstInvalid(form);
  };
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("correct", { month: monthLabel })}</summary>
      <form
        className="flex flex-col gap-3 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          guard.intercept(event.currentTarget, go);
        }}
      >
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
          <input type="hidden" name="assignmentId" value={assignment.id} />
          <input type="hidden" name="expectedRevision" value={assignment.revision} />
          <PlanRadios plans={plans} defaultValue={assignment.planId} invalid={Boolean(fieldErrors.planId)} />
          <div>
            <Button type="submit" aria-busy={pending || undefined}>
              {t("correctSubmit")}
            </Button>
          </div>
        </fieldset>
      </form>
      <NoPlanDialog studentName={studentName} guard={guard} pending={pending} onConfirm={go} />
    </details>
  );
}

function NoPlanDialog({ studentName, guard, pending, onConfirm }: {
  studentName: string;
  guard: ReturnType<typeof useNoPlanGuard>;
  pending: boolean;
  onConfirm: (form: HTMLFormElement) => Promise<void>;
}) {
  const t = useTranslations("payments.readiness.forms.assignment");
  const form = guard.pendingNoPlan;
  return (
    <ConfirmDialog
      open={form !== null}
      onOpenChange={(open) => !open && guard.setPendingNoPlan(null)}
      title={t("noPlanTitle")}
      confirmLabel={t("noPlanSubmit")}
      pending={pending}
      onConfirm={async () => {
        if (form) await onConfirm(form);
        guard.setPendingNoPlan(null);
      }}
    >
      <p className="text-foreground">{t("noPlanBody", { name: studentName })}</p>
      <p>{t("noPlanCurrent")}</p>
    </ConfirmDialog>
  );
}
