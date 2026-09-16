import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// REDESIGN_BRIEF.md Phase 3 "Pill": ok/warn/bad are semantic status: never
// yellow for "good" (Rule 2). "accent" is a sanctioned, non-semantic gold use
// (mock's Examen/Franja flag pills) — distinct from the status trio, same
// ruling as Button's "primary" variant. "plain" is neutral/no status.
const pillVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        ok: "border-ok-line bg-ok-soft text-ok",
        warn: "border-warn-line bg-warn-soft text-warn",
        bad: "border-bad-line bg-bad-soft text-bad",
        accent: "border-brand-gold/30 bg-brand-gold/15 text-foreground",
        plain: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "plain",
    },
  },
);

const DOT_CLASS = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  accent: "bg-brand-gold",
  plain: "bg-muted-foreground",
} as const;

export interface PillProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof pillVariants> {}

export function Pill({ className, variant = "plain", children, ...props }: PillProps) {
  const resolvedVariant = variant ?? "plain";
  return (
    <span className={cn(pillVariants({ variant }), className)} {...props}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[resolvedVariant])} />
      {children}
    </span>
  );
}
