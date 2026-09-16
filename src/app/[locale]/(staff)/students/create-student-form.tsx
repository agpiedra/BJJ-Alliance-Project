"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createStudent, type CreateStudentState } from "./create-student-action";

function stripeRange(maxStripes: number): number[] {
  return Array.from({ length: maxStripes + 1 }, (_, i) => i);
}

const INITIAL_STATE: CreateStudentState = {};

type Academy = { id: string; name: string };

export interface CreateStudentRankOption {
  id: string;
  code: string;
  track: "ADULT" | "KIDS";
  order: number;
  maxStripes: number;
  labelEs: string;
  labelEn: string;
}

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx gate) — but the real
// enforcement is server-side in `createStudent` itself (requireTenantContext
// + isAcademyInTenantScope), never this UI check alone.
export function CreateStudentForm({
  organizationId,
  academies,
  rankOptions,
}: {
  organizationId: string;
  academies: Academy[];
  rankOptions: CreateStudentRankOption[];
}) {
  const t = useTranslations("students.create");
  const locale = useLocale();
  const [state, formAction, isPending] = useActionState(createStudent.bind(null, organizationId), INITIAL_STATE);

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: "Selecting the track filters
  // the rank dropdown to that track's ranks... Default on create: first
  // rank of the chosen track, 0 degrees." ADULT is the default track —
  // preserves this form's pre-3c-i behavior for the common case.
  const [track, setTrack] = useState<"ADULT" | "KIDS">("ADULT");
  const ranksForTrack = rankOptions.filter((r) => r.track === track).sort((a, b) => a.order - b.order);
  const [rankId, setRankId] = useState(ranksForTrack[0]?.id ?? "");
  const [stripes, setStripes] = useState(0);

  // Changing track or rank always resets degrees to 0 — a stripe count
  // valid for the previous selection (e.g. 4 on an adult belt) is not
  // necessarily valid for the new one (e.g. a kids rank capped at 0 for a
  // terminal row, or a real range up to 11), so re-picking from scratch is
  // safer than trying to clamp a stale value.
  function handleTrackChange(nextTrack: "ADULT" | "KIDS") {
    setTrack(nextTrack);
    const firstRank = rankOptions.filter((r) => r.track === nextTrack).sort((a, b) => a.order - b.order)[0];
    setRankId(firstRank?.id ?? "");
    setStripes(0);
  }

  function handleRankChange(nextRankId: string) {
    setRankId(nextRankId);
    setStripes(0);
  }

  const selectedRank = ranksForTrack.find((r) => r.id === rankId) ?? ranksForTrack[0];

  const guardianNameErrors = state.fieldErrors?.guardianName;

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && state.code && (
        <div className="mt-4 flex flex-col gap-2 rounded border border-green-600 bg-green-50 p-3">
          <p>{t("successCodeWarning")}</p>
          <p className="text-3xl font-mono font-bold tracking-widest">{state.code}</p>
        </div>
      )}

      <form action={formAction} className="mt-4 flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("firstName")}</span>
          <input type="text" name="firstName" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("lastName")}</span>
          <input type="text" name="lastName" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("phone")}</span>
          <input type="tel" name="phone" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>

        {academies.length === 1 ? (
          <input type="hidden" name="homeAcademyId" value={academies[0].id} />
        ) : (
          <label className="flex flex-col gap-1">
            <span>{t("homeAcademy")}</span>
            <select name="homeAcademyId" required className="rounded border px-3 py-2">
              {academies.map((academy) => (
                <option key={academy.id} value={academy.id}>
                  {academy.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span>{t("trackLabel")}</span>
          <select
            name="track"
            required
            value={track}
            onChange={(event) => handleTrackChange(event.target.value as "ADULT" | "KIDS")}
            className="rounded border px-3 py-2"
          >
            <option value="ADULT">{t("trackAdult")}</option>
            <option value="KIDS">{t("trackKids")}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("currentBelt")}</span>
          <select
            name="currentRankId"
            required
            value={rankId}
            onChange={(event) => handleRankChange(event.target.value)}
            className="rounded border px-3 py-2"
          >
            {ranksForTrack.map((rank) => (
              <option key={rank.id} value={rank.id}>
                {locale === "es" ? rank.labelEs : rank.labelEn}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currentStripes")}</span>
          <select
            name="currentStripes"
            required
            value={stripes}
            onChange={(event) => setStripes(Number(event.target.value))}
            className="rounded border px-3 py-2"
          >
            {stripeRange(selectedRank?.maxStripes ?? 0).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("dateOfBirth")}</span>
          <input type="date" name="dateOfBirth" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("guardianName")}</span>
          <input type="text" name="guardianName" className="rounded border px-3 py-2" />
        </label>
        {guardianNameErrors && guardianNameErrors.length > 0 && (
          <p className="text-sm text-red-600">{t("guardianRequiredForMinor")}</p>
        )}
        <label className="flex flex-col gap-1">
          <span>{t("guardianPhone")}</span>
          <input type="tel" name="guardianPhone" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("emergencyContact")}</span>
          <input type="text" name="emergencyContact" className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
