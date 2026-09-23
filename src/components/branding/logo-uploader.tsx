"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { deriveForeground, deriveInitials } from "@/lib/theme";
import { ACCEPTED_MIME_TYPES, MAX_LOGO_BYTES } from "@/lib/branding/logo-constraints";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

/**
 * Convenience only, never enforcement — validateAndReencodeLogo (server)
 * runs the real check regardless of what this returns, same as every other
 * guard in this project. This exists purely so a director picking an
 * oversized or wrong-format file sees the exact same message instantly,
 * before a single byte leaves the browser, instead of waiting on a round
 * trip only to get told the same thing.
 */
function clientValidationError(file: File): "tooLarge" | "invalidFormat" | null {
  if (file.size > MAX_LOGO_BYTES) return "tooLarge";
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) return "invalidFormat";
  return null;
}

export interface LogoUploaderProps {
  organizationId: string;
  logoUrl: string | null;
  displayName: string;
  /** The sidebar background to preview against — doc: "the logo preview...
   * must render against the chosen sidebar color, not against white." */
  previewBackground: string;
  uploadAction: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
  removeAction: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * Standalone and reusable (see theme-picker.tsx's own doc comment — Phase
 * 5's onboarding wizard renders this same component). ADMIN and DIRECTOR
 * sessions can both submit either action successfully (PR 1 — widened from
 * ADMIN-only, matching the page's own ADMIN/DIRECTOR gate); the server's
 * real `resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"])` is
 * what actually enforces it, never a hidden button.
 */
export function LogoUploader({
  organizationId,
  logoUrl,
  displayName,
  previewBackground,
  uploadAction,
  removeAction,
}: LogoUploaderProps) {
  const t = useTranslations("branding.logo");
  const [uploadState, uploadFormAction, isUploading] = useActionState(
    uploadAction.bind(null, organizationId),
    INITIAL_STATE,
  );
  const [removeState, removeFormAction, isRemoving] = useActionState(
    removeAction.bind(null, organizationId),
    INITIAL_STATE,
  );
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [clientError, setClientError] = useState<"tooLarge" | "invalidFormat" | null>(null);
  // A submission's server result belongs to the file that was selected when
  // it was sent. Picking a DIFFERENT file afterwards — whether the previous
  // submission already resolved (a stale error/success sitting under the
  // now-irrelevant new selection) or hasn't resolved yet (an in-flight
  // result that would otherwise land under a file the director already
  // moved past) — retires that old result immediately. Cleared right
  // before a submission actually goes out, so that submission's own result
  // is shown once it arrives.
  const [dismissServerFeedback, setDismissServerFeedback] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  function setPreview(url: string | null) {
    // Revoke the previous object URL before replacing or clearing it —
    // otherwise every file selection leaks the last one's blob URL for the
    // life of the page.
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewFile(url);
  }

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const displayedError = clientError ?? (dismissServerFeedback ? undefined : uploadState.error);
  const displayedSuccess = !clientError && !dismissServerFeedback && uploadState.ok;

  const initials = deriveInitials(displayName);
  const initialsForeground = deriveForeground(previewBackground);

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl"
        style={{ backgroundColor: previewBackground }}
      >
        {previewFile || logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external Supabase URL, not a local static asset next/image can optimize
          <img src={previewFile ?? logoUrl!} alt={displayName} className="h-full w-full object-contain p-2" />
        ) : (
          <span className="text-2xl font-bold" style={{ color: initialsForeground }}>
            {initials}
          </span>
        )}
      </div>

      <form
        action={uploadFormAction}
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          if (clientError) {
            // Never call the server action for a file this component already
            // knows is invalid — the server re-checks regardless, but there's
            // no reason to spend a round trip confirming what's already known.
            e.preventDefault();
            return;
          }
          setPreview(null);
          // This submission's own result should render once it arrives —
          // see the field's own doc comment for why it was set otherwise.
          setDismissServerFeedback(false);
        }}
      >
        <input
          type="file"
          name="logo"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // A different selection retires any result tied to the previous
            // one, whether it already arrived (stale) or hasn't yet
            // (in-flight) — see the field's own doc comment.
            setDismissServerFeedback(true);
            if (!file) {
              setPreview(null);
              setClientError(null);
              return;
            }
            const error = clientValidationError(file);
            setClientError(error);
            setPreview(error ? null : URL.createObjectURL(file));
          }}
        />
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {displayedError && (
          <p className="text-sm text-bad">{t.has(`error.${displayedError}`) ? t(`error.${displayedError}` as never) : t("error.generic")}</p>
        )}
        {displayedSuccess && <p className="text-sm text-ok">{t("uploaded")}</p>}
        <Button type="submit" disabled={isUploading || !!clientError} size="sm">
          {t("upload")}
        </Button>
      </form>

      {logoUrl && (
        <form action={removeFormAction}>
          {removeState.error && <p className="text-sm text-bad">{t("error.generic")}</p>}
          <Button type="submit" variant="outline" size="sm" disabled={isRemoving}>
            {t("remove")}
          </Button>
        </form>
      )}
    </div>
  );
}
