"use client";

import { createContext, useActionState, useContext, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createLocation, type CreateLocationState } from "@/lib/locations/location-actions";

const INITIAL_STATE: CreateLocationState = {};
const INPUT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export interface IssuedKioskToken {
  academyId: string;
  name: string;
  slug: string;
  token: string;
}

const IssuedTokensContext = createContext<{
  issued: IssuedKioskToken[];
  add: (token: IssuedKioskToken) => void;
  dismiss: (academyId: string) => void;
}>({ issued: [], add: () => {}, dismiss: () => {} });

/**
 * ONE place for the kiosk tokens issued on this page. The plaintext token exists
 * only in the response to "add a location" (just its hash is stored), so it must
 * not live in anything the page's refresh can unmount — the same shape, and the
 * same reason, as the staff invitation link. Unlike an invitation link, an
 * earlier location's token is still VALID, so a newer one never replaces it: each
 * stays until it is dismissed or the page is left.
 */
export function LocationTokenProvider({ children }: { children: ReactNode }) {
  const [issued, setIssued] = useState<IssuedKioskToken[]>([]);
  const add = (token: IssuedKioskToken) => setIssued((current) => [token, ...current.filter((item) => item.academyId !== token.academyId)]);
  const dismiss = (academyId: string) => setIssued((current) => current.filter((item) => item.academyId !== academyId));
  return <IssuedTokensContext.Provider value={{ issued, add, dismiss }}>{children}</IssuedTokensContext.Provider>;
}

export function IssuedKioskTokens() {
  const { issued } = useContext(IssuedTokensContext);
  if (issued.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {issued.map((item) => (
        <KioskTokenPanel key={item.academyId} item={item} />
      ))}
    </div>
  );
}

/** The kiosk link, built here from the token this action just returned — it is never persisted, so no later read could find it. */
function KioskTokenPanel({ item }: { item: IssuedKioskToken }) {
  const t = useTranslations("adminLocations");
  const locale = useLocale();
  const { dismiss } = useContext(IssuedTokensContext);
  const [copied, setCopied] = useState(false);
  const kioskUrl = `${window.location.origin}/${locale}/kiosk/${item.slug}?token=${item.token}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(kioskUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the link stays selectable in the field below.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="kiosk-token-panel">
      <p className="text-sm text-warn">{t("token.warning")}</p>
      <label className="flex flex-col gap-1 text-sm">
        <span>
          {t("token.label")} · {item.name}
        </span>
        <input type="text" readOnly value={kioskUrl} onFocus={(event) => event.currentTarget.select()} className={`${INPUT} font-mono text-xs`} />
      </label>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? t("token.copied") : t("token.copy")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => dismiss(item.academyId)}>
          {t("token.dismiss")}
        </Button>
      </div>
    </div>
  );
}

export function AddLocationForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations("adminLocations");
  const { add } = useContext(IssuedTokensContext);
  // Controlled, so a REFUSED add (a duplicate name) keeps what was typed — React
  // resets an uncontrolled form after every action, failed ones included. Only a
  // successful add clears the fields for the next.
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [state, formAction, isPending] = useActionState(async (previous: CreateLocationState, formData: FormData) => {
    const result = await createLocation(organizationId, previous, formData);
    if (result.ok && result.academyId && result.slug && result.kioskToken) {
      add({ academyId: result.academyId, name: result.name ?? "", slug: result.slug, token: result.kioskToken });
      setName("");
      setAddress("");
    }
    return result;
  }, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("add.heading")}</p>
      <p className="text-sm text-muted-foreground">{t("add.hint")}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("fields.name")}</span>
          <input type="text" name="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("fields.address")}</span>
          <input type="text" name="address" maxLength={200} value={address} onChange={(event) => setAddress(event.target.value)} className={INPUT} />
        </label>
      </div>
      {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
      {state.ok && <p className="text-sm text-ok">{t("add.success")}</p>}
      <div>
        <Button type="submit" disabled={isPending}>
          {t("add.submit")}
        </Button>
      </div>
    </form>
  );
}
