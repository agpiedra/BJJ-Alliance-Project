"use server";

import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import { getAttendanceHistoryPage } from "@/lib/students/attendance-history";
import { ATTENDANCE_PAGE_SIZE, toAttendanceRow, type AttendanceRow } from "@/lib/portal/attendance-rows";

export type LoadMoreAttendanceState =
  | { ok: true; rows: AttendanceRow[]; nextCursor: string | null }
  | { ok: false; error: "invalid" | "failed" };

/**
 * "Show older attendance": the next page of the CALLER'S OWN history. There is deliberately no student id in the
 * input - whose history it is comes from the session (`linkedStudentId`, re-derived from the database by the
 * tenant context), so another student's records cannot be requested by tampering with the request. The cursor is
 * an opaque keyset token; an unreadable one returns an empty last page (see `getAttendanceHistoryPage`).
 */
export async function loadMoreAttendance(organizationId: string, cursor: string): Promise<LoadMoreAttendanceState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);
  if (!auth.ok) return { ok: false, error: "invalid" };
  const studentId = auth.context.linkedStudentId;
  if (!studentId || typeof cursor !== "string" || cursor === "") return { ok: false, error: "invalid" };

  try {
    const locale = await getLocale();
    const page = await getAttendanceHistoryPage(studentId, auth.context.organizationId, { cursor, limit: ATTENDANCE_PAGE_SIZE });
    return { ok: true, rows: page.entries.map((entry) => toAttendanceRow(entry, locale)), nextCursor: page.nextCursor };
  } catch (error) {
    console.error("[portal] failed to load more attendance", { organizationId: auth.context.organizationId, error });
    return { ok: false, error: "failed" };
  }
}
