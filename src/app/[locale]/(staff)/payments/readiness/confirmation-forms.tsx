"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { acknowledgePricing, recordOpeningReview } from "@/lib/dues/readiness/opening-actions";
import { ConfirmDialog } from "./form-fields";
import { useScopedSubmit } from "./use-readiness-action";

/**
 * Stage 8d-2 (plan §3.4, §3.5): opening reviews and pricing acknowledgements. The binding is the one the server computed from
 * the SAME snapshot as the content this dialog restates; it is never computed here. The dialog always shows the CURRENT props: if
 * a refresh brings a new binding while it is open, it closes, so a confirmation can never pair new content with an old look, or
 * the reverse. After a `stale` refusal the owner must open it again (a fresh review) and press again; nothing resubmits.
 */

type Candidate = { year: number; month: number; label: string };

function useBindingCloses(binding: string, setOpen: (open: boolean) => void) {
  const seen = useRef(binding);
  useEffect(() => {
    if (seen.current !== binding) {
      seen.current = binding;
      setOpen(false);
    }
  }, [binding, setOpen]);
}

export function OpeningReviewControl({ organizationId, studentId, studentName, candidate, binding, drafts }: {
  organizationId: string;
  studentId: string;
  studentName: string;
  candidate: Candidate;
  binding: string;
  /** The active drafts exactly as displayed on the card. */
  drafts: readonly string[];
}) {
  const t = useTranslations("payments.readiness.forms.review");
  const { submit, pending, locked } = useScopedSubmit(`student:${studentId}`, "card");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useBindingCloses(binding, setOpen);
  const none = drafts.length === 0;
  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left" disabled={locked} onClick={() => setOpen(true)}>
        {none ? t("confirmNone", { month: candidate.label }) : t("confirmItems", { month: candidate.label, count: drafts.length })}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dialogTitle", { name: studentName })}
        confirmLabel={t("submit")}
        pending={pending}
        finalFocus={triggerRef}
        onConfirm={async () => {
          const fd = new FormData();
          fd.set("studentId", studentId);
          fd.set("candidateYear", String(candidate.year));
          fd.set("candidateMonth", String(candidate.month));
          fd.set("binding", binding);
          fd.set("declaration", none ? "noOpeningDebt" : "itemsAsShown");
          await submit((data) => recordOpeningReview(organizationId, {}, data), fd);
          setOpen(false);
        }}
      >
        <p className="text-foreground">{none ? t("attestNone", { month: candidate.label }) : t("attestItems", { month: candidate.label, count: drafts.length })}</p>
        {!none && (
          <ul className="list-disc pl-5 text-foreground">
            {drafts.map((d, index) => (
              <li key={index} className="break-words">
                {d}
              </li>
            ))}
          </ul>
        )}
        <p>{t("scope", { month: candidate.label })}</p>
      </ConfirmDialog>
    </>
  );
}

export function PricingAckControl({ organizationId, studentId, studentName, candidate, binding, lines }: {
  organizationId: string;
  studentId: string;
  studentName: string;
  candidate: Candidate;
  binding: string;
  /** What is acknowledged, exactly as displayed: the promo/exempt legacy rows, the plan and what S would charge. */
  lines: readonly string[];
}) {
  const t = useTranslations("payments.readiness.forms.pricing");
  const { submit, pending, locked } = useScopedSubmit(`student:${studentId}`, "card");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useBindingCloses(binding, setOpen);
  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left" disabled={locked} onClick={() => setOpen(true)}>
        {t("acknowledge", { month: candidate.label })}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dialogTitle", { name: studentName })}
        confirmLabel={t("submit")}
        pending={pending}
        finalFocus={triggerRef}
        onConfirm={async () => {
          const fd = new FormData();
          fd.set("studentId", studentId);
          fd.set("candidateYear", String(candidate.year));
          fd.set("candidateMonth", String(candidate.month));
          fd.set("binding", binding);
          await submit((data) => acknowledgePricing(organizationId, {}, data), fd);
          setOpen(false);
        }}
      >
        <ul className="list-disc pl-5 text-foreground">
          {lines.map((line, index) => (
            <li key={index} className="break-words">
              {line}
            </li>
          ))}
        </ul>
        <p>{t("scope", { month: candidate.label })}</p>
      </ConfirmDialog>
    </>
  );
}
