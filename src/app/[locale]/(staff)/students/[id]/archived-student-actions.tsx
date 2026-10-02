import { RestoreStudentButton } from "./restore-student-button";
import { ReturnToTrainingButton } from "./return-to-training-button";
import type { ArchiveEventResolution } from "@/lib/students/archive-event";

/**
 * Genuine-return-to-training brief (D22): the ARCHIVED-student action set, extracted from `page.tsx` purely so this
 * exact markup decision is unit-testable (a Server Component page itself cannot be rendered in a jsdom test the way
 * this repo's other button components already are — `create-student-form.test.tsx`/`approve-student-button.test.tsx`
 * are the established pattern this mirrors).
 *
 * CORRECTED: the wrapping `<div>` must appear ONLY when `ReturnToTrainingButton` is genuinely going to render —
 * wrapping unconditionally would add new markup around `RestoreStudentButton` for every ARCHIVED student, in every
 * organization, regardless of billing state, which is not "zero new DOM" for the always-inactive-today case. When
 * `trustworthyArchiveEvent` is not `ok` (covers both billing-inactive and no-trustworthy-event), this renders
 * EXACTLY what `page.tsx` rendered for an ARCHIVED student before this brief — the same single button, same JSX
 * shape, no wrapping element.
 */
export function ArchivedStudentActions({
  organizationId,
  studentId,
  trustworthyArchiveEvent,
}: {
  organizationId: string;
  studentId: string;
  trustworthyArchiveEvent: ArchiveEventResolution | null;
}) {
  if (trustworthyArchiveEvent?.ok) {
    return (
      <div className="flex flex-col items-start gap-4">
        <RestoreStudentButton organizationId={organizationId} studentId={studentId} />
        <ReturnToTrainingButton organizationId={organizationId} studentId={studentId} archiveEventId={trustworthyArchiveEvent.archiveEventId} />
      </div>
    );
  }
  return <RestoreStudentButton organizationId={organizationId} studentId={studentId} />;
}
