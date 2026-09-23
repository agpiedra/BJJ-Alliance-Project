import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";

/**
 * A server action does not re-render the page it was called from unless it says
 * that page is stale. Awarding, correcting, changing track or recording an
 * attendance day all change the progress the staff pages show, so without this the
 * student page kept the old rank and count beside "Promotion awarded." (found in a
 * real browser). Covers the student's own page, the roster and the dashboard queue.
 *
 * Best-effort, never the reason a committed change reports failure: `revalidatePath`
 * needs Next's request-scoped store, which does not exist when an action is called
 * directly (the integration tests do), and the change is already committed by now.
 */
export async function refreshPromotionPages(studentId: string): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/students/${studentId}`);
    revalidatePath(`/${locale}/students`);
    revalidatePath(`/${locale}/dashboard`);
  } catch (error) {
    console.error("[promotion] failed to revalidate the staff pages", { studentId, error });
  }
}
