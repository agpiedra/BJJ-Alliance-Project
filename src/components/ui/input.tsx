import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

/**
 * The same control look for native `<select>` and date/time fields (which cannot use the Base UI `Input`): the >= 3:1
 * boundary, a card fill, 44px on coarse pointers, and NO focus-outline override, so the global 2px ring shows. Shared
 * by the filter bar and the schedule and kiosk forms, which each carried their own copy of an older class string that
 * switched the outline off.
 */
const FIELD_CLASS =
  "h-9 rounded-sm border border-input bg-card px-3 text-sm text-foreground pointer-coarse:h-11 focus-visible:border-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // MATROOM Phase 1: --input is the >= 3:1 control boundary; the fill is the card colour; focus is the global 2px ring
        // (globals.css) plus an ink border; invalid is a 2px destructive border (not colour alone: width changes too).
        "h-9 w-full min-w-0 rounded-sm border border-input bg-card px-3 py-1 text-base text-foreground transition-colors pointer-coarse:h-11 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-2 aria-invalid:border-destructive aria-invalid:px-[11px] md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input, FIELD_CLASS }
