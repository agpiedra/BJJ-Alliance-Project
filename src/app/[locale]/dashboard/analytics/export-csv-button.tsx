"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { toCsv } from "@/lib/analytics/csv";

/**
 * The ONE shared CSV download trigger for every director-analytics panel
 * (`toCsv`, `@/lib/analytics/csv`, is the one shared builder it calls) —
 * later tasks in this phase pass their own panel's rows/filename into this
 * same component rather than growing a second export button.
 *
 * Client-side only: builds the CSV in the browser and triggers a download
 * via a throwaway object-URL anchor, no server round trip needed for data
 * the page already rendered.
 */
export function ExportCsvButton({
  rows,
  filename,
}: {
  rows: Record<string, string | number>[];
  filename: string;
}) {
  const t = useTranslations("dashboard.analytics");

  function handleClick() {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick}>
      {t("exportCsv")}
    </Button>
  );
}
