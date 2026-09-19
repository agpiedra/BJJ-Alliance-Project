"use server";

import { signOut } from "@/auth";

/**
 * Not `signOutStaff`/`signOutStudent` (sign-out-actions.ts) — this actor is
 * neither: `isSuperAdmin` is a platform-wide flag, not an organization
 * membership, so there's no `selected_academy` cookie or student-portal
 * concept to clean up. Same one-line `signOut()` call, kept as its own
 * honestly-named function rather than reusing a name that would misdescribe
 * who's signing out.
 */
export async function signOutPlatformAdmin(locale: string): Promise<void> {
  await signOut({ redirectTo: `/${locale}/login` });
}
