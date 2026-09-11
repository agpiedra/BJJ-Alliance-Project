"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setSelectedAcademy } from "@/lib/staff-shell/academy-switcher-actions";

export interface AcademySwitcherAcademy {
  id: string;
  name: string;
}

export interface AcademySwitcherProps {
  academies: AcademySwitcherAcademy[];
  /** null = "ver ambas sedes" is the current selection. */
  selectedAcademyId: string | null;
  /** DIRECTOR/INSTRUCTOR get read-only text, never a dropdown (brief §Phase 2). */
  readOnly: boolean;
}

/**
 * UI + cookie persistence only (ruling recorded in
 * academy-switcher-actions.ts) — selecting an academy does not filter any
 * page's data yet.
 */
export function AcademySwitcher({ academies, selectedAcademyId, readOnly }: AcademySwitcherProps) {
  const t = useTranslations("staffShell.academySwitcher");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (readOnly) {
    // Never routes through selectedAcademyId — the layout forces that to
    // null for every non-ADMIN session, which would otherwise make this
    // always render the "both locations" label instead of the director's
    // or instructor's actual (usually single) assigned academy.
    const readOnlyLabel = academies.map((a) => a.name).join(", ");
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-sidebar-foreground">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand-gold" />
        <span className="truncate font-medium">{readOnlyLabel}</span>
      </div>
    );
  }

  const selected = academies.find((a) => a.id === selectedAcademyId);
  const currentLabel = selected ? selected.name : t("bothSelected");

  function choose(academyId: string | null) {
    startTransition(async () => {
      await setSelectedAcademy(academyId);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isPending}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand-gold" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{currentLabel}</span>
          <span className="truncate text-xs opacity-70">{t("bothLabel")}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => choose(null)}>{t("bothLabel")}</DropdownMenuItem>
        {academies.map((academy) => (
          <DropdownMenuItem key={academy.id} onClick={() => choose(academy.id)}>
            {academy.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
