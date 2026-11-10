"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { activateLedger, approveActivation, withdrawActivationApproval } from "@/lib/dues/readiness/activation-actions";
import { acknowledgeNoMoney } from "@/lib/dues/readiness/opening-actions";
import { ConfirmDialog } from "./form-fields";
import { ScopeStatus, useScopedSubmit } from "./use-readiness-action";

/**
 * Stage 9 PR 9-3: the owner's activation panel (A1–A8, approved 2026-11-10). Everything shown is computed on the server from one
 * snapshot and passed in as text; this component only submits and reports the RESPONSE:
 * - a success refreshes the page (the server's current state is then shown, never inferred here);
 * - a refusal names its reason (and the failing checks or students it lists); nothing was written;
 * - a call that throws is an UNKNOWN outcome — the switch may or may not have committed — so nothing is retried, and the owner
 *   reloads to see the real state.
 * Old-system rows for S and later are listed with their A8 class; an ambiguous one offers the owner's per-row acknowledgement
 * "no money was received for this row", bound to the exact content shown (`binding`, computed by the server).
 */

export type PanelLegacyRow = {
  legacyId: string;
  studentId: string;
  /** "Ana Mora, November 2026 (Pending)" */
  label: string;
  /** Stored method and notes, exactly as stored (the reason a pending row is ambiguous). */
  detail: string | null;
  classification: "placeholder" | "ambiguousPending" | "recordedPayment" | "waiver" | "inconsistent";
  acknowledgement: "missing" | "valid" | "stale" | null;
  binding: string;
};

export type PanelChangedStudent = { studentId: string; name: string; approvedTotals: string; currentTotals: string; refreshed: boolean };

type Action = "approve" | "withdraw" | "activate";
type Outcome =
  | { kind: "idle" }
  | { kind: "pending"; action: Action }
  | { kind: "saved"; action: Action }
  | { kind: "refused"; action: Action; error: string; failing: string[]; students: string[] }
  | { kind: "unknown"; action: Action };

const KNOWN_ERRORS = new Set([
  "notFound", "invalid", "alreadyActive", "approvalExists", "tooLate", "stale", "notReady", "busy", "noApproval", "windowNotOpen",
  "windowClosed", "configurationChanged", "needsReconfirmation", "progressRowExists",
]);

export function ActivationPanel(props: {
  organizationId: string;
  candidate: { year: number; month: number; label: string };
  ready: boolean;
  organizationFingerprint: string;
  /** Formatted in `zone`; null when the organization has no branch. */
  window: { approvalDeadline: string; opensAt: string; closesAt: string; zone: string } | null;
  live: {
    startLabel: string;
    approvedAt: string;
    effectiveAt: string | null;
    forThisMonth: boolean;
    configurationMatches: boolean | null;
    changedStudents: PanelChangedStudent[] | null;
  } | null;
  legacyRows: PanelLegacyRow[];
  /** Check titles by key, and student names by id, to name what a refusal lists. */
  checkTitles: Record<string, string>;
  studentNames: Record<string, string>;
}) {
  const t = useTranslations("payments.readiness.activation");
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [dialog, setDialog] = useState<Action | null>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const withdrawRef = useRef<HTMLButtonElement>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const busy = outcome.kind === "pending" || outcome.kind === "unknown";
  const { live, window: win, candidate } = props;

  async function run(action: Action) {
    if (busy) return;
    setOutcome({ kind: "pending", action });
    let result: { ok: boolean; error?: string; failing?: { key: string }[]; students?: string[] };
    try {
      if (action === "approve") {
        const fd = new FormData();
        fd.set("candidateYear", String(candidate.year));
        fd.set("candidateMonth", String(candidate.month));
        fd.set("organizationFingerprint", props.organizationFingerprint);
        result = await approveActivation(props.organizationId, fd);
      } else if (action === "withdraw") {
        result = await withdrawActivationApproval(props.organizationId);
      } else {
        result = await activateLedger(props.organizationId);
      }
    } catch {
      setDialog(null);
      setOutcome({ kind: "unknown", action });
      setTimeout(() => statusRef.current?.focus(), 0);
      return;
    }
    setDialog(null);
    if (result.ok) {
      setOutcome({ kind: "saved", action });
      router.refresh();
    } else {
      setOutcome({
        kind: "refused",
        action,
        error: result.error ?? "unexpected",
        failing: (result.failing ?? []).map((f) => props.checkTitles[f.key] ?? f.key),
        students: (result.students ?? []).map((id) => props.studentNames[id] ?? id),
      });
    }
    setTimeout(() => statusRef.current?.focus(), 0);
  }

  return (
    <section aria-labelledby="activation-heading" className="flex min-w-0 flex-col gap-4 rounded-xl border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="activation-heading" className="text-base font-semibold">
          {t("heading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      {live?.effectiveAt ? (
        <p className="rounded-lg border border-ok-line bg-ok-soft p-3 text-sm">{t("active", { month: live.startLabel, time: live.effectiveAt })}</p>
      ) : live ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("approved", { month: live.startLabel, time: live.approvedAt })}</p>
          {!live.forThisMonth ? (
            <p className="text-sm text-muted-foreground">{t("approvedOtherMonth", { month: live.startLabel })}</p>
          ) : (
            <>
              {win && <p className="text-sm">{t("window", { opens: win.opensAt, closes: win.closesAt, zone: win.zone })}</p>}
              <p className="text-sm text-muted-foreground">{t("noPause")}</p>
              {live.configurationMatches === false && <p className="text-sm text-bad">{t("configurationChanged")}</p>}
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{t("changedHeading")}</h3>
                {live.changedStudents && live.changedStudents.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-sm">
                    {live.changedStudents.map((s) => (
                      <li key={s.studentId} className="min-w-0 break-words">
                        <strong>{s.name}</strong>: {t("totalsChange", { before: s.approvedTotals, after: s.currentTotals })} —{" "}
                        <span className={s.refreshed ? "text-ok" : "text-bad"}>{s.refreshed ? t("refreshed") : t("needsRefresh")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("noneChanged")}</p>
                )}
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {live.forThisMonth && (
              <Button ref={activateRef} type="button" disabled={busy} onClick={() => setDialog("activate")}>
                {t("activate", { month: live.startLabel })}
              </Button>
            )}
            <Button ref={withdrawRef} type="button" variant="outline" disabled={busy} onClick={() => setDialog("withdraw")}>
              {t("withdraw")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {win && <p className="text-sm">{t("approveBy", { month: candidate.label, deadline: win.approvalDeadline, zone: win.zone })}</p>}
          {!props.ready && <p className="text-sm text-muted-foreground">{t("approveNeedsReady")}</p>}
          <div>
            <Button ref={approveRef} type="button" disabled={busy || !props.ready} onClick={() => setDialog("approve")}>
              {t("approve", { month: candidate.label })}
            </Button>
          </div>
        </div>
      )}

      <div ref={statusRef} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {outcome.kind === "pending" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("pending")}
          </p>
        )}
        {outcome.kind === "saved" && (
          <p role="status" className="text-sm text-ok">
            {t(`saved.${outcome.action}`)}
          </p>
        )}
        {outcome.kind === "refused" && (
          <div role="alert" className="flex flex-col gap-1 text-sm text-bad">
            <p>{t(`refused.${KNOWN_ERRORS.has(outcome.error) ? outcome.error : "unexpected"}`)}</p>
            {outcome.failing.length > 0 && (
              <ul className="list-disc pl-5">
                {outcome.failing.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            {outcome.students.length > 0 && (
              <ul className="list-disc pl-5">
                {outcome.students.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {outcome.kind === "unknown" && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm">
            <p className="font-semibold">{t("unknownTitle")}</p>
            <p>{t("unknownBody")}</p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
                {t("reload")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <LegacyFromStart rows={props.legacyRows} organizationId={props.organizationId} candidate={candidate} />

      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(open) => setDialog(open ? "approve" : null)}
        title={t("approveTitle", { month: candidate.label })}
        confirmLabel={t("approveConfirm")}
        pending={outcome.kind === "pending"}
        finalFocus={approveRef}
        onConfirm={() => void run("approve")}
      >
        <p className="text-foreground">{t("approveBody", { month: candidate.label })}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "withdraw"}
        onOpenChange={(open) => setDialog(open ? "withdraw" : null)}
        title={t("withdrawTitle")}
        confirmLabel={t("withdrawConfirm")}
        pending={outcome.kind === "pending"}
        finalFocus={withdrawRef}
        onConfirm={() => void run("withdraw")}
      >
        <p className="text-foreground">{t("withdrawBody")}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "activate"}
        onOpenChange={(open) => setDialog(open ? "activate" : null)}
        title={t("activateTitle", { month: live?.startLabel ?? candidate.label })}
        confirmLabel={t("activateConfirm")}
        pending={outcome.kind === "pending"}
        finalFocus={activateRef}
        onConfirm={() => void run("activate")}
      >
        <ul className="list-disc pl-5 text-foreground">
          <li>{t("activateEffectLegacy")}</li>
          <li>{t("activateEffectOpening")}</li>
          <li>{t("activateEffectMonthly", { month: live?.startLabel ?? candidate.label })}</li>
          <li>{t("activateEffectNoUndo")}</li>
        </ul>
      </ConfirmDialog>
    </section>
  );
}

function LegacyFromStart({ rows, organizationId, candidate }: { rows: PanelLegacyRow[]; organizationId: string; candidate: { year: number; month: number; label: string } }) {
  const t = useTranslations("payments.readiness.activation");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("legacyHeading", { month: candidate.label })}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("legacyNone", { month: candidate.label })}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {rows.map((row) => {
            const acknowledged = row.classification === "ambiguousPending" && row.acknowledgement === "valid";
            return (
              <li key={row.legacyId} className="flex flex-col gap-1 py-2">
                <span className="min-w-0 break-words">{row.label}</span>
                {row.detail && <span className="min-w-0 break-words text-muted-foreground">{row.detail}</span>}
                <span className={row.classification === "placeholder" || acknowledged ? "text-ok" : "text-bad"}>
                  {acknowledged ? t("class.acknowledged") : t(`class.${row.classification}`)}
                  {row.classification === "ambiguousPending" && row.acknowledgement === "stale" ? ` ${t("class.ackStale")}` : ""}
                </span>
                {row.classification === "ambiguousPending" && !acknowledged && <NoMoneyControl organizationId={organizationId} candidate={candidate} row={row} />}
                <ScopeStatus scope={`student:${row.studentId}`} place="card" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NoMoneyControl({ organizationId, candidate, row }: { organizationId: string; candidate: { year: number; month: number; label: string }; row: PanelLegacyRow }) {
  const t = useTranslations("payments.readiness.activation");
  const { submit, pending, locked } = useScopedSubmit(`student:${row.studentId}`, "card");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div>
        <Button ref={trigger} type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left" disabled={locked} onClick={() => setOpen(true)}>
          {t("noMoney")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("noMoneyTitle")}
        confirmLabel={t("noMoneyConfirm")}
        pending={pending}
        finalFocus={trigger}
        onConfirm={async () => {
          const fd = new FormData();
          fd.set("studentId", row.studentId);
          fd.set("legacyPaymentPeriodId", row.legacyId);
          fd.set("candidateYear", String(candidate.year));
          fd.set("candidateMonth", String(candidate.month));
          fd.set("binding", row.binding);
          await submit((data) => acknowledgeNoMoney(organizationId, {}, data), fd);
          setOpen(false);
        }}
      >
        <p className="text-foreground">{row.label}</p>
        {row.detail && <p className="text-foreground">{row.detail}</p>}
        <p>{t("noMoneyBody")}</p>
      </ConfirmDialog>
    </>
  );
}
