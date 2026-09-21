/**
 * "Is there anything to choose between?" — the one rule behind every place that
 * offers "all locations": the sidebar switcher and the Both filters on Students,
 * Payments and Analytics. At exactly ONE location there is nothing to choose, so
 * nothing offers a choice; `tests/unit/academy-choice.test.tsx` fails the build if
 * a surface offers "all" without consulting this.
 */
export function hasAcademyChoice(academies: readonly unknown[]): boolean {
  return academies.length > 1;
}

/**
 * The location the shell says you are looking at. Only an Owner with a real choice
 * can be looking at "all locations"; with one location — or as a director or
 * instructor, who only ever see their own — it is simply the name(s).
 */
export function academyScopeLabel({
  isOwner,
  academies,
  selectedAcademyId,
  allLabel,
}: {
  isOwner: boolean;
  academies: readonly { id: string; name: string }[];
  selectedAcademyId: string | null;
  allLabel: string;
}): string {
  if (isOwner && hasAcademyChoice(academies)) {
    return academies.find((academy) => academy.id === selectedAcademyId)?.name ?? allLabel;
  }
  return academies.map((academy) => academy.name).join(", ");
}
