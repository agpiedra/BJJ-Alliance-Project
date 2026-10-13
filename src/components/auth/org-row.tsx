import { ChevronRight } from "lucide-react";
import { cn } from "cn";

/**
 * The card-with-chevron organization-selection row from the Phase 2.6
 * prototype (`design/matroom/preview/phase2.6-app/organization-selection.html`
 * `.org-card`/`.mark`/`.meta`): a 44px mark badge, the organization's name
 * and the member's role, and a trailing decorative chevron. Pure
 * presentation — the caller wraps this in the real `<button type="submit">`
 * of the real per-organization `<form>`, so clicking it is the same real
 * `selectOrganization` action as before, just with a richer row inside it.
 */
export function OrgRow({
  mark,
  markTone = "primary",
  name,
  role,
}: {
  mark: string;
  markTone?: "primary" | "secondary";
  name: string;
  role: string;
}) {
  return (
    <span className="flex min-h-[72px] items-center gap-3.5 rounded-lg border border-border bg-card p-3 group-hover:bg-accent">
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-sm text-sm font-bold",
          markTone === "secondary" ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground",
        )}
      >
        {mark}
      </span>
      {/* No truncation: the approved prototype's .org-card .name/.small have no overflow/ellipsis rule —
          a long organization name is meant to wrap, not hide the text that distinguishes it from another row. */}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{name}</span>
        <span className="block text-xs text-muted-foreground">{role}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />
    </span>
  );
}
