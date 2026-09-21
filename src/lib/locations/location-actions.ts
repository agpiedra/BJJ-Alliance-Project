"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import type { ActionState } from "@/lib/action-state";
import { createLocationForOwner, type CreatedLocation } from "@/lib/locations/location-service";

/**
 * Adding a location — OWNER ONLY. Resolves the caller's context for the
 * organization it NAMES (never the ambient session selector) and demands
 * `ADMIN`: a location director or instructor is refused (`FORBIDDEN`), a caller
 * with no membership in that organization is told `notFound` — the same
 * "disclose to members, never to non-members" rule every other action follows.
 * `tests/unit/staff-actions-are-owner-only.test.ts` fails the build if an
 * exported action here stops demanding the Owner.
 *
 * There is deliberately no timezone field: a new location gets the column's
 * default, like the first one, and anything a form sends for it is not read.
 */

/** On success the plaintext kiosk token rides back ONCE — only its hash is stored. */
export type CreateLocationState = ActionState & Partial<CreatedLocation>;

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
});

async function refreshAfterCreate(): Promise<void> {
  // Best-effort, same shape as the other actions: revalidatePath needs a real
  // request-scoped store that a direct test call doesn't have, and the write has
  // already committed. The whole locale layout, because its location switcher
  // lists the organization's academies.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}`, "layout");
  } catch (error) {
    console.error("[location-actions] failed to revalidate", { error });
  }
}

export async function createLocation(organizationId: string, _prevState: ActionState, formData: FormData): Promise<CreateLocationState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };

  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address") ?? undefined,
  });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };

  const result = await createLocationForOwner(auth.context, parsed.data);
  if ("error" in result) return { error: result.error };

  await refreshAfterCreate();
  return result;
}
