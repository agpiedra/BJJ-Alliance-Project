import { cn } from "cn";

/**
 * REDESIGN_BRIEF.md Phase 3 "DataTable": mono uppercase <th>, row hover,
 * overflow-x wrapper, last row has no bottom border. Plain styled <table>
 * sub-components (same pattern as ui/card.tsx's Card* family) — not a
 * data-grid abstraction, callers still map their own rows.
 */
export function DataTable({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table className={cn("w-full border-collapse text-left", className)} {...props} />
    </div>
  );
}

export function DataTableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("bg-muted", className)} {...props} />;
}

export function DataTableHeaderRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={className} {...props} />;
}

export function DataTableHeaderCell({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-mono text-[10.5px] font-medium tracking-[.11em] text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function DataTableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody className={cn("divide-y divide-border [&>tr:last-child]:border-b-0", className)} {...props} />
  );
}

export function DataTableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("hover:bg-muted/60", className)} {...props} />;
}

export function DataTableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-[9px] align-middle text-xs leading-[18px]", className)} {...props} />;
}
