"use server";

import { cookies } from "next/headers";

/**
 * REDESIGN_BRIEF.md Phase 2 ruling: the switcher is UI + persistence only —
 * it does not (yet) filter any query. It just remembers ADMIN's preferred
 * academy so pages built in later phases (Alumnos/Resumen/Horario, each of
 * which already has or will have its own academy filter select) can default
 * to it instead of "all academies". `null` means "ver ambas sedes".
 *
 * This action itself does NOT validate `academyId` against the real academy
 * list or the caller's role — (staff)/layout.tsx re-validates the cookie
 * against both on every read before trusting it. That is sufficient today
 * only because nothing filters a query off this cookie yet; a future phase
 * that reads this cookie before layout re-validation would need its own
 * check here too.
 */
export async function setSelectedAcademy(academyId: string | null): Promise<void> {
  const store = await cookies();
  if (academyId) {
    store.set("selected_academy", academyId, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  } else {
    store.delete("selected_academy");
  }
}
