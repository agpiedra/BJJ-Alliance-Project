import type { ReactNode } from "react";
import { cn } from "cn";

export interface EmptyStateProps {
  message: ReactNode;
  /** The one action that fixes it — brief Rule 4: never a blank chart. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-10 text-center", className)}>
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}
