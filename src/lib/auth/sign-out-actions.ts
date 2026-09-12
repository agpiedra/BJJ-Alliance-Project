"use server";

import { signOut } from "@/auth";
import { setSelectedAcademy } from "@/lib/staff-shell/academy-switcher-actions";

/**
 * REDESIGN_BRIEF.md Phase 7: sign-out for the three staff portals (admin,
 * director, instructor — rail footer and avatar menu both call this). Also
 * clears the `selected_academy` cookie (the ADMIN academy-switcher's pick,
 * academy-switcher-actions.ts) so a fresh login doesn't inherit the
 * previous session's academy scope.
 */
export async function signOutStaff(locale: string): Promise<void> {
  await setSelectedAcademy(null);
  await signOut({ redirectTo: `/${locale}/login` });
}

/**
 * Student portal sign-out (Phase 7). No `selected_academy` cookie to clear
 * here — that cookie only exists for the ADMIN academy-switcher.
 */
export async function signOutStudent(locale: string): Promise<void> {
  await signOut({ redirectTo: `/${locale}/login` });
}
