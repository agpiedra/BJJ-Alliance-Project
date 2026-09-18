"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { deriveForeground, deriveInitials } from "@/lib/theme";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

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
 * 5's onboarding wizard renders this same component). Only ADMIN sessions
 * can actually submit either action successfully (item 2) — this form is
 * still shown to a DIRECTOR viewing the settings page (consistent with the
 * rest of the page being ADMIN/DIRECTOR-visible), and the server's real
 * `resolveActionContext(organizationId, ["ADMIN"])` is what actually
 * enforces it, never a hidden button.
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
        onSubmit={() => setPreviewFile(null)}
      >
        <input
          type="file"
          name="logo"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setPreviewFile(file ? URL.createObjectURL(file) : null);
          }}
        />
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {uploadState.error && (
          <p className="text-sm text-bad">
            {t.has(`error.${uploadState.error}`) ? t(`error.${uploadState.error}` as never) : t("error.generic")}
          </p>
        )}
        {uploadState.ok && <p className="text-sm text-ok">{t("uploaded")}</p>}
        <Button type="submit" disabled={isUploading} size="sm">
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
