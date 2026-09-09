import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listClassSessions } from "./queries";
import { CreateClassSessionForm } from "./create-class-session-form";
import { EditClassSessionForm } from "./edit-class-session-form";
import { DeactivateClassSessionButton } from "./deactivate-class-session-button";

// The academy list and its schedule are staff data that can change without a
// redeploy — never frozen at build time, same reasoning as the roster and
// kiosk-tokens pages.
export const dynamic = "force-dynamic";

type ScheduleSearchParams = {
  academyId?: string;
};

export default async function AdminSchedulePage({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  // ADMIN-only — schedule structure is academy policy (spec §5), not
  // something a DIRECTOR/INSTRUCTOR session can reach. The unscoped academy
  // list below (both Escazú and Escalante, regardless of assignment) is only
  // safe to read because this call already rejected any non-ADMIN session.
  await requireStaffSession(["ADMIN"]);
  const params = await searchParams;

  const academies = await prisma.academy.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const selectedAcademyId =
    params.academyId && academies.some((academy) => academy.id === params.academyId)
      ? params.academyId
      : academies[0]?.id;

  const sessions = selectedAcademyId ? await listClassSessions(selectedAcademyId) : [];

  const t = await getTranslations("adminSchedule");
  const tDay = await getTranslations("dayOfWeek");
  const tType = await getTranslations("classType");

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("academySelector")}</span>
          <select
            name="academyId"
            defaultValue={selectedAcademyId ?? ""}
            className="rounded border px-3 py-2"
          >
            {academies.map((academy) => (
              <option key={academy.id} value={academy.id}>
                {academy.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          {t("selectorSubmit")}
        </Button>
      </form>

      {/* Server-side gate is the real enforcement (createClassSession itself
          re-checks the role) — this only avoids showing the control on a page
          no other role can reach anyway. */}
      {selectedAcademyId && <CreateClassSessionForm academyId={selectedAcademyId} />}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-4">{t("table.day")}</th>
              <th className="py-2 pr-4">{t("table.startTime")}</th>
              <th className="py-2 pr-4">{t("table.duration")}</th>
              <th className="py-2 pr-4">{t("table.name")}</th>
              <th className="py-2 pr-4">{t("table.type")}</th>
              <th className="py-2 pr-4">{t("table.countsTowardPromotion")}</th>
              <th className="py-2 pr-4">{t("table.status")}</th>
              <th className="py-2 pr-4">
                <span className="sr-only">{t("table.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className={`border-b ${session.active ? "" : "opacity-60"}`}>
                <td className="py-2 pr-4">{tDay(session.dayOfWeek)}</td>
                <td className="py-2 pr-4">{session.startTime}</td>
                <td className="py-2 pr-4">{session.durationMinutes}</td>
                <td className="py-2 pr-4">{session.name}</td>
                <td className="py-2 pr-4">{tType(session.type)}</td>
                <td className="py-2 pr-4">
                  {session.countsTowardPromotion ? t("table.yes") : t("table.no")}
                </td>
                <td className="py-2 pr-4">
                  <Badge variant={session.active ? "outline" : "secondary"}>
                    {session.active ? t("table.active") : t("table.inactive")}
                  </Badge>
                </td>
                <td className="flex flex-col gap-2 py-2 pr-4">
                  <EditClassSessionForm session={session} />
                  {session.active && (
                    <DeactivateClassSessionButton classSessionId={session.id} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && <p className="py-4 text-muted-foreground">{t("empty")}</p>}
      </div>
    </main>
  );
}
