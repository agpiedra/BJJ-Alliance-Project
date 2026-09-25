import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-sm border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-all select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:border-border disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        // REDESIGN_BRIEF.md Phase 3 "Button" spec + the mock's own rendered
        // CTAs (Inscribir alumno, Guardar pago, Graduar) all use solid gold
        // for primary actions — extending the sanctioned gold-use list from
        // "sidebar active-nav, banner accents, stat highlights" (Phase 1) to
        // include primary CTA buttons, per "the mock wins for visuals."
        // MATROOM Phase 1: the tenant's action colour. `border-action-edge` is a presentation token (BrandingScope): a 1px
        // --input edge when the tenant's fill is under 3:1 against the surface, otherwise transparent. The stored colour
        // is never altered.
        primary: "border-action-edge bg-brand-gold text-brand-gold-foreground hover:bg-brand-gold/90",
        outline:
          "border-input bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "border-input bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground disabled:border-transparent disabled:bg-transparent",
        destructive:
          "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline disabled:border-transparent disabled:bg-transparent",
      },
      // Touch targets: compact on a fine pointer (dense tables), 44px on a coarse one (WCAG 2.2 target size, phones and kiosks).
      size: {
        default:
          "h-9 gap-1.5 px-3 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-7 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs pointer-coarse:h-11 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] pointer-coarse:h-11 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-3.5 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-9 pointer-coarse:size-11",
        "icon-xs":
          "size-7 rounded-[min(var(--radius-md),10px)] pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 rounded-[min(var(--radius-md),12px)] pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10 pointer-coarse:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `loading` is the pending state of an action: the button is disabled (so it cannot be pressed twice), marked
 * `aria-busy`, and shows a spinner beside its label. Callers keep passing their own pending label as children
 * (e.g. "Guardando...") exactly as before; nothing about `disabled` changes for callers that do not use `loading`.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  // `children` stays inside `props` (never destructured and re-passed as JSX children): this component is also used as a
  // Base UI `render={<Button />}` target (the schedule page's Sheet trigger), where the trigger supplies the label through
  // the props it merges in. Re-passing it as JSX children rendered that trigger empty in the real app.
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
      {...(loading ? { children: (<><Loader2 aria-hidden="true" className="animate-spin" />{props.children}</>) } : {})}
    />
  )
}

export { Button, buttonVariants }
