import { createTranslator } from "next-intl";
import type { Belt, NotificationType } from "@/generated/prisma/client";
import { routing } from "@/i18n/routing";
import type { RenderedMessage } from "@/lib/notifications/types";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

// Same discipline as class-popularity.ts's `translateDayOfWeek`: read
// straight from the same messages files next-intl's request config loads,
// resolved through `createTranslator` (never a hand-rolled JSON read or
// `getTranslations`/`getLocale`, which need a live Next.js request context
// this module doesn't have when called from a background job or an
// integration test hitting the DB directly).
const MESSAGES: Record<string, typeof esMessages> = {
  es: esMessages,
  en: enMessages,
};

function messagesFor(locale: string): typeof esMessages {
  // ponytail: only "es"/"en" are ever passed (routing.locales) in practice;
  // this fallback is defensive-only, matching class-popularity.ts's pattern.
  return MESSAGES[locale] ?? MESSAGES[routing.defaultLocale];
}

function translateBelt(belt: Belt, locale: string): string {
  const t = createTranslator({ locale, messages: messagesFor(locale), namespace: "belt" });
  return t(belt);
}

/**
 * Renders a notification's title/body for one `NotificationType` in the
 * given locale. `data`'s shape is documented per-case below — this is the
 * one place stringly-typed data enters the notification system, so a future
 * 5th type must document its own `data` contract here the same way.
 */
export function renderNotificationMessage(
  type: NotificationType,
  data: Record<string, unknown>,
  locale: string,
): RenderedMessage {
  const t = createTranslator({ locale, messages: messagesFor(locale), namespace: "notifications" });

  switch (type) {
    // data: { studentName: string; belt: Belt; stripes: number } — a student
    // just earned a new stripe at their current belt (performCheckIn's
    // `earnedStripe` true, `summaryAfter.examEligible` false).
    case "STRIPE_THRESHOLD": {
      const studentName = data.studentName as string;
      const belt = translateBelt(data.belt as Belt, locale);
      const stripes = data.stripes as number;
      return {
        type,
        title: t("stripeThreshold.title", { studentName }),
        body: t("stripeThreshold.body", { studentName, belt, stripes }),
      };
    }

    // data: { studentName: string; belt: Belt } — a student is now eligible
    // for a belt exam (performCheckIn's `earnedStripe` true,
    // `summaryAfter.examEligible` true).
    case "EXAM_THRESHOLD": {
      const studentName = data.studentName as string;
      const belt = translateBelt(data.belt as Belt, locale);
      return {
        type,
        title: t("examThreshold.title", { studentName }),
        body: t("examThreshold.body", { studentName, belt }),
      };
    }

    // data: { studentName: string } — a new student signed up and is
    // awaiting staff approval (Student.status "PENDING").
    case "NEW_SIGNUP": {
      const studentName = data.studentName as string;
      return {
        type,
        title: t("newSignup.title"),
        body: t("newSignup.body", { studentName }),
      };
    }

    // data: { academyName: string; newSignups: number; overduePayments:
    // number } — one academy's weekly summary counts (Vercel Cron trigger,
    // email-only per the plan's ruling).
    case "WEEKLY_DIGEST": {
      const academyName = data.academyName as string;
      const newSignups = data.newSignups as number;
      const overduePayments = data.overduePayments as number;
      return {
        type,
        title: t("weeklyDigest.title", { academyName }),
        body: t("weeklyDigest.body", { academyName, newSignups, overduePayments }),
      };
    }
  }
}
