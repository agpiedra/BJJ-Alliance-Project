import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "cn";
import { FIELD_CLASS, Input } from "@/components/ui/input";

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 border-b border-border px-4 py-3", className)}>
      {children}
    </div>
  );
}

export function FilterBarSearch({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <div className={cn("relative min-w-[200px] flex-1", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input className="pl-8" {...props} />
    </div>
  );
}

/**
 * Native <select>, not a new dropdown component — every existing filter in
 * the app (admin/schedule, students) already uses a plain <select>; this
 * just gives it FilterBar-consistent styling.
 */
export function FilterBarSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        FIELD_CLASS,
        className,
      )}
      {...props}
    />
  );
}
