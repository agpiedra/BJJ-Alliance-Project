"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { updateStudent } from "./actions";
import type { Belt } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

type EditableStudent = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  currentBelt: Belt;
  currentStripes: number;
  dateOfBirth: Date | null;
  guardianName: string | null;
  guardianPhone: string | null;
  emergencyContact: string | null;
  notes: string | null;
};

function toDateInputValue(date: Date | null): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx gate) — the real
// enforcement is server-side in `updateStudent` itself
// (requireStaffSession + isAcademyInScope re-checked against a fresh read),
// never this UI check alone.
export function EditStudentForm({ student }: { student: EditableStudent }) {
  const t = useTranslations("students.detail.edit");
  // Field labels are identical concepts to Task 7's create form — reuse
  // that namespace instead of duplicating every label under detail.edit.
  const tField = useTranslations("students.create");
  const tBelt = useTranslations("belt");
  const [state, formAction, isPending] = useActionState(updateStudent, INITIAL_STATE);

  const guardianNameErrors = state.fieldErrors?.guardianName;

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && <p className="mt-4 text-sm text-green-700">{t("success")}</p>}

      <form action={formAction} className="mt-4 flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="studentId" value={student.id} />

        <label className="flex flex-col gap-1">
          <span>{tField("firstName")}</span>
          <input
            type="text"
            name="firstName"
            required
            defaultValue={student.firstName}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("lastName")}</span>
          <input
            type="text"
            name="lastName"
            required
            defaultValue={student.lastName}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("phone")}</span>
          <input
            type="tel"
            name="phone"
            required
            defaultValue={student.phone}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("email")}</span>
          <input
            type="email"
            name="email"
            required
            defaultValue={student.email}
            className="rounded border px-3 py-2"
          />
        </label>
        {/* Belt and stripes are DISPLAY-ONLY here — no form control, so
            nothing about rank is submitted to `updateStudent` (its schema
            no longer accepts either field). Changing them is Phase 4's
            promotion flow, which must also write a `Promotion` row and
            reset `beltAwardedAt`; a silent field edit would leave rank
            disagreeing with promotion history. */}
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{tField("currentBelt")}</span>
          <p>{tBelt(student.currentBelt)}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{tField("currentStripes")}</span>
          <p>{student.currentStripes}</p>
        </div>
        <p className="text-sm text-muted-foreground">{t("beltReadOnly")}</p>

        <label className="flex flex-col gap-1">
          <span>{tField("dateOfBirth")}</span>
          <input
            type="date"
            name="dateOfBirth"
            defaultValue={toDateInputValue(student.dateOfBirth)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("guardianName")}</span>
          <input
            type="text"
            name="guardianName"
            defaultValue={student.guardianName ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        {guardianNameErrors && guardianNameErrors.length > 0 && (
          <p className="text-sm text-red-600">{tField("guardianRequiredForMinor")}</p>
        )}
        <label className="flex flex-col gap-1">
          <span>{tField("guardianPhone")}</span>
          <input
            type="tel"
            name="guardianPhone"
            defaultValue={student.guardianPhone ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("emergencyContact")}</span>
          <input
            type="text"
            name="emergencyContact"
            defaultValue={student.emergencyContact ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("notes")}</span>
          <textarea
            name="notes"
            defaultValue={student.notes ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
