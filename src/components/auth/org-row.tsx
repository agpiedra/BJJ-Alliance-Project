import { cn } from "cn";

/**
 * The organization-selection row demonstrated by the approved prototype
 * (`.org-row`/`.org-mark`/`.org-meta` in auth-access-phase-prototype.html):
 * a mark badge, the organization's name, and the member's role at it. Pure
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
    <span className="flex items-center gap-3 rounded-sm border border-input bg-card p-3 group-hover:bg-accent">
      <span
        className={cn(
          "flex size-[34px] shrink-0 items-center justify-center rounded-sm text-sm font-bold",
          markTone === "secondary" ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground",
        )}
      >
        {mark}
      </span>
      {/* No truncation: the approved prototype's .org-meta .name/.role have no overflow/ellipsis rule —
          a long organization name is meant to wrap, not hide the text that distinguishes it from another row. */}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{name}</span>
        <span className="block text-xs text-muted-foreground">{role}</span>
      </span>
    </span>
  );
}
