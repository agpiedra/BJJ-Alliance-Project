"use client";

import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import {
  createInvoiceAction,
  recordInvoicePaymentAction,
  voidInvoiceAction,
  acknowledgeInvoiceReviewAction,
  extendInvoiceGraceAction,
  updateOrganizationGraceDaysAction,
} from "../billing-actions";
import type { InvoiceState } from "@/lib/billing/deadline";

export interface BillingInvoiceRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  deadline: string;
  state: InvoiceState;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  unreviewed: boolean;
  reviewAcknowledgedAt: string | null;
}

const STATE_PILL_VARIANT: Record<InvoiceState, "ok" | "warn" | "bad"> = {
  CURRENT: "ok",
  DUE: "warn",
  GRACE_EXPIRED: "bad",
};

function GraceDaysForm({ organizationId, graceDays }: { organizationId: string; graceDays: number }) {
  const t = useTranslations("billing.detail");
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(String(graceDays));

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-sm">
        <span>{t("graceDaysLabel")}</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
            disabled={isPending}
          />
          <Button
            size="sm"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await updateOrganizationGraceDaysAction(organizationId, value);
              })
            }
          >
            {t("graceDaysSave")}
          </Button>
        </div>
      </label>
      <p className="text-xs text-muted-foreground">{t("graceDaysHelp")}</p>
    </div>
  );
}

function NewInvoiceForm({ organizationId }: { organizationId: string; graceDays: number }) {
  const t = useTranslations("billing.detail.newInvoice");
  const [state, formAction, isPending] = useActionState(createInvoiceAction.bind(null, organizationId), INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("heading")}</h3>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("periodStart")}</span>
          <Input type="date" name="periodStart" required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("periodEnd")}</span>
          <Input type="date" name="periodEnd" required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("dueOn")}</span>
          <Input type="date" name="dueOn" required />
        </label>
      </div>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div>
        <Button type="submit" size="sm" disabled={isPending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

function InvoiceRow({ invoice }: { invoice: BillingInvoiceRow }) {
  const t = useTranslations("billing.detail.invoiceRow");
  const tStatus = useTranslations("billing.status");
  const [isPending, startTransition] = useTransition();
  const [extending, setExtending] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [note, setNote] = useState("");
  const [extensionDays, setExtensionDays] = useState("0");
  const [error, setError] = useState<string | null>(null);

  const resolved = Boolean(invoice.paidAt || invoice.voidedAt);

  return (
    <div className="flex flex-col gap-1 border-b border-border py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("period", { periodStart: invoice.periodStart, periodEnd: invoice.periodEnd })}</span>
        <div className="flex items-center gap-2">
          {invoice.unreviewed && <Pill variant="bad">{t("unreviewed")}</Pill>}
          {!invoice.unreviewed && invoice.reviewAcknowledgedAt && invoice.state === "GRACE_EXPIRED" && (
            <Pill variant="warn">{t("acknowledged")}</Pill>
          )}
          <Pill variant={STATE_PILL_VARIANT[invoice.state]}>{tStatus(invoice.state)}</Pill>
        </div>
      </div>
      <div className="text-muted-foreground">
        {t("due", { dueOn: invoice.dueOn })} · {t("deadline", { deadline: invoice.deadline })}
      </div>
      {invoice.paidAt && <div className="text-ok">{t("paid", { paidAt: invoice.paidAt })}</div>}
      {invoice.voidedAt && <div className="text-muted-foreground">{t("voided", { reason: invoice.voidReason ?? "" })}</div>}
      {error && <p className="text-destructive">{t(`errors.${error}` as "errors.noteRequired")}</p>}

      {!resolved && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await recordInvoicePaymentAction(invoice.id, undefined);
                if (result.error) setError(result.error);
              });
            }}
          >
            {t("recordPayment")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={() => {
              if (!confirm(t("confirmVoid"))) return;
              setError(null);
              startTransition(async () => {
                const result = await voidInvoiceAction(invoice.id, "Voided by platform admin");
                if (result.error) setError(result.error);
              });
            }}
          >
            {t("void")}
          </Button>
          {invoice.unreviewed && (
            <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setAcknowledging(true)}>
              {t("acknowledge")}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setExtending(true)}>
            {t("extend")}
          </Button>
        </div>
      )}

      {acknowledging && (
        <div className="flex flex-col gap-2 pt-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("noteLabel")} disabled={isPending} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await acknowledgeInvoiceReviewAction(invoice.id, note);
                  if (result.error) setError(result.error);
                  else setAcknowledging(false);
                });
              }}
            >
              {t("acknowledge")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAcknowledging(false)}>
              ×
            </Button>
          </div>
        </div>
      )}

      {extending && (
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs">{t("extensionDaysLabel")}</span>
            <Input type="number" min={0} step={1} value={extensionDays} onChange={(e) => setExtensionDays(e.target.value)} disabled={isPending} />
          </label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("noteLabel")} disabled={isPending} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await extendInvoiceGraceAction(invoice.id, extensionDays, note);
                  if (result.error) setError(result.error);
                  else setExtending(false);
                });
              }}
            >
              {t("extend")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExtending(false)}>
              ×
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BillingSection({
  organizationId,
  graceDays,
  invoices,
}: {
  organizationId: string;
  graceDays: number;
  invoices: BillingInvoiceRow[];
}) {
  const t = useTranslations("billing.detail");

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold">{t("heading")}</h2>
        <GraceDaysForm organizationId={organizationId} graceDays={graceDays} />
        <NewInvoiceForm organizationId={organizationId} graceDays={graceDays} />
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t("invoicesHeading")}</h3>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noInvoices")}</p>
          ) : (
            invoices.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} />)
          )}
        </div>
      </CardContent>
    </Card>
  );
}
