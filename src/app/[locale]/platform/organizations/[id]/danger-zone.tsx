"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle, AlertDialogDescription, AlertDialogActions } from "@/components/ui/alert-dialog";
import { suspendOrganizationAction, reactivateOrganizationAction, cancelOrganizationAction } from "../actions";
import type { OrganizationStatus } from "@/generated/prisma/client";

export function DangerZone({ organizationId, status }: { organizationId: string; status: OrganizationStatus }) {
  const t = useTranslations("platform.organizations.detail.dangerZone");
  const [isPending, startTransition] = useTransition();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suspendTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const suspendCancelRef = useRef<HTMLButtonElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);

  // Single close path for every way the cancel dialog can end (the ghost button, Escape via
  // onOpenChange, a successful submission) so the note/error reset never drifts between them.
  // NOT called on a failed submission -- that's the one path that must leave the dialog open
  // with the note and error message both intact.
  function closeCancelDialog() {
    setCancelOpen(false);
    setNote("");
    setError(null);
  }

  if (status === "CANCELLED") {
    return <p className="text-sm text-muted-foreground">{t("alreadyCancelled")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {status === "ACTIVE" && (
          <Button ref={suspendTriggerRef} variant="destructive" size="sm" disabled={isPending} onClick={() => setSuspendOpen(true)}>
            {t("suspend")}
          </Button>
        )}
        {status === "SUSPENDED" && (
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                await reactivateOrganizationAction(organizationId);
              });
            }}
          >
            {t("reactivate")}
          </Button>
        )}
        <Button
          ref={cancelTriggerRef}
          variant="destructive"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setError(null);
            setCancelOpen(true);
          }}
        >
          {t("cancel")}
        </Button>
      </div>

      {/* Initial focus on the dismiss action, not the destructive one -- no text input here to
          prioritize instead, so focus defaults away from the irreversible action (planning
          round's documented recommendation). Final focus returns to the real button that opened
          this dialog, not left to the default previously-focused-element guess. */}
      <AlertDialog
        open={suspendOpen}
        onOpenChange={(open, eventDetails) => {
          // A user-driven close (Escape -- outside-press is already disabled by AlertDialog
          // itself) while the suspend request is in flight would hide a later server error with
          // no dialog left to show it in. Both trigger buttons are already `disabled={isPending}`,
          // so only one dialog can ever be open while a request is pending -- blocking dismissal
          // on the shared `isPending` flag is correct for both dialogs, not a cross-action bug.
          if (!open && isPending) {
            eventDetails.cancel();
            return;
          }
          setSuspendOpen(open);
        }}
      >
        <AlertDialogPopup initialFocus={suspendCancelRef} finalFocus={suspendTriggerRef}>
          <AlertDialogTitle>{t("suspend")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmSuspend")}</AlertDialogDescription>
          <AlertDialogActions>
            <Button ref={suspendCancelRef} variant="ghost" size="sm" disabled={isPending} onClick={() => setSuspendOpen(false)}>
              {t("suspendDialogCancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  await suspendOrganizationAction(organizationId);
                  setSuspendOpen(false);
                });
              }}
            >
              {t("suspend")}
            </Button>
          </AlertDialogActions>
        </AlertDialogPopup>
      </AlertDialog>

      {/* Initial focus on the note field -- the required-reason input now lives inside the same
          surface as the confirmation, instead of a separate card state disconnected from the
          native confirm() that used to follow it. The dialog stays open on a server error so the
          message and the user's typed note are never lost (no setCancelOpen(false) on failure). */}
      <AlertDialog
        open={cancelOpen}
        onOpenChange={(open, eventDetails) => {
          // Same pending-dismissal guard as the suspend dialog above: Escape while the
          // cancellation request is in flight must not clear the note or hide a later error.
          if (!open && isPending) {
            eventDetails.cancel();
            return;
          }
          if (open) setCancelOpen(true);
          else closeCancelDialog();
        }}
      >
        <AlertDialogPopup initialFocus={noteInputRef} finalFocus={cancelTriggerRef}>
          <AlertDialogTitle>{t("cancel")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmCancel")}</AlertDialogDescription>
          <label className="mt-3 flex flex-col gap-1 text-sm font-medium">
            {t("cancelNotePlaceholder")}
            <Input
              ref={noteInputRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isPending}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "danger-zone-cancel-error" : undefined}
            />
          </label>
          {error && (
            <p id="danger-zone-cancel-error" className="mt-2 text-sm text-destructive">
              {t(error as "confirmCancel")}
            </p>
          )}
          <AlertDialogActions>
            <Button variant="ghost" size="sm" disabled={isPending} onClick={closeCancelDialog}>
              {t("cancelDialogCancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await cancelOrganizationAction(organizationId, note);
                  if (result.error) {
                    setError(result.error);
                    return;
                  }
                  closeCancelDialog();
                });
              }}
            >
              {t("confirmCancelButton")}
            </Button>
          </AlertDialogActions>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
