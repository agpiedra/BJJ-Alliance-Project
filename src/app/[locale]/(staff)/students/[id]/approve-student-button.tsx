"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { approveStudent } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

type PlanOption = { id: string; name: string };

// Rendered only for an ADMIN/DIRECTOR session looking at a PENDING student
// (page.tsx gate) — the real enforcement is server-side in `approveStudent`
// itself (requireTenantContext(["ADMIN", "DIRECTOR"]) + isAcademyInTenantScope
// re-checked against a fresh read + a PENDING precondition asserted in the
// UPDATE's own WHERE clause), never this UI check alone.
export function ApproveStudentButton({
  organizationId,
  studentId,
  billingActive = false,
  existingPlanName,
  plans = [],
  organizationRole,
}: {
  organizationId: string;
  studentId: string;
  /** Enrollment/resume integration plan §7.6: resolved server-side (always false today) — `false` renders this
   * component exactly as it has always rendered, zero new DOM. */
  billingActive?: boolean;
  /** `undefined`: no assignment resolves for the enrollment month (a selector may be offered). `null`: an
   * assignment exists but is explicitly unassigned. A string: the existing assignment's plan name, reused. */
  existingPlanName?: string | null;
  plans?: PlanOption[];
  /** Only meaningful when `billingActive` and no existing assignment: creating a NEW one is ADMIN-only. */
  organizationRole?: "ADMIN" | "DIRECTOR";
}) {
  const t = useTranslations("students.detail.approve");
  const [state, formAction, isPending] = useActionState(approveStudent.bind(null, organizationId), INITIAL_STATE);
  const [planId, setPlanId] = useState("");
  const needsNewAssignment = billingActive && existingPlanName === undefined;

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="studentId" value={studentId} />
      {billingActive && existingPlanName !== undefined && (
        <p className="text-sm text-muted-foreground">{t("planReused", { plan: existingPlanName ?? t("planNone") })}</p>
      )}
      {needsNewAssignment &&
        (organizationRole === "ADMIN" ? (
          <label className="flex flex-col gap-1">
            <span>{t("planLabel")}</span>
            <select name="planId" value={planId} onChange={(event) => setPlanId(event.target.value)} className="rounded border px-3 py-2">
              <option value="">{t("planNone")}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">{t("planRequiresAdmin")}</p>
        ))}
      {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
