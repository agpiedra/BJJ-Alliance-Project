"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { cn } from "cn"

// Base UI's AlertDialog (not Dialog): built for an interruption that requires an explicit
// response, so dismissing via outside click is disabled by default (unlike Dialog) — matches
// "destructive actions must run only after explicit confirmation." Escape-to-close, a real
// focus trap, and focus restoration to the triggering element are all built-in behaviors of
// the underlying primitive, not reimplemented here.

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogBackdrop({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogPopup({
  className,
  children,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPortal>
      <AlertDialogBackdrop />
      <AlertDialogPrimitive.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
        <AlertDialogPrimitive.Popup
          data-slot="alert-dialog-popup"
          className={cn(
            "w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none transition duration-150 ease-in-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPortal>
  )
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-actions"
      className={cn("mt-4 flex flex-wrap justify-end gap-2 [&>*]:flex-1 [&>*]:basis-35 sm:[&>*]:flex-none", className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogActions,
}
