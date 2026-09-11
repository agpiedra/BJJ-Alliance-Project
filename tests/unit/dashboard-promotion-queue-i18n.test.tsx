/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { PromotionStatusLabel } from "@/app/[locale]/(staff)/dashboard/promotion-status-label";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * Regression test for a real shipped bug (Phase 4 Task 4 fix round 1):
 * `page.tsx`'s promotion-queue status column looked up a message key under
 * the wrong namespace (`"status.stripe-eligible"` instead of
 * `"promotionQueue.status.stripe-eligible"`). next-intl doesn't throw for a
 * missing key by default — it logs `MISSING_MESSAGE` to the console and
 * renders the raw dotted path as visible text — so the bug was silent to
 * every automated check (unit, integration, tsc, lint, build) and was only
 * caught by a reviewer manually running a real `next-intl` translator
 * against the real message files. No committed test previously existed to
 * catch a regression of this exact bug class.
 *
 * Follows `tests/unit/dev-belts-page.test.tsx`'s established pattern: render
 * real UI inside a real `NextIntlClientProvider` with the real message
 * files, and assert on actual human-readable rendered text — never on the
 * JSON structure or the component's internal key-lookup logic, which is
 * exactly what would let a wrong-namespace bug like this one slip through
 * undetected again.
 *
 * `PromotionStatusLabel` (not the full `DashboardPage`) is rendered here
 * because `DashboardPage` is an async Server Component that hits the real
 * DB (`requireStaffSession`, `prisma`, `listPromotionQueue`/
 * `listApproachingStudents`) — impractical to render in a jsdom unit test.
 * `PromotionStatusLabel` is the exact, real component `page.tsx` renders for
 * every promotion-queue row's Status column (not a reimplementation copy),
 * so this test exercises the real production code path end to end,
 * including the real `QUEUE_STATUS_KEY` lookup table.
 */
describe("PromotionStatusLabel (dashboard promotion-queue i18n)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders 'Stripe eligible' for status='stripe-eligible' in English — not a raw dotted path", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PromotionStatusLabel status="stripe-eligible" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Stripe eligible")).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.status/)).not.toBeInTheDocument();
    expect(screen.queryByText(/promotionQueue\.status/)).not.toBeInTheDocument();
  });

  it("renders 'Elegible para grado' for status='stripe-eligible' in Spanish — not a raw dotted path", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <PromotionStatusLabel status="stripe-eligible" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Elegible para grado")).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.status/)).not.toBeInTheDocument();
  });

  it("renders 'Exam eligible' for status='exam-eligible' in English — not a raw dotted path", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PromotionStatusLabel status="exam-eligible" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Exam eligible")).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.status/)).not.toBeInTheDocument();
  });

  it("renders 'Elegible para examen' for status='exam-eligible' in Spanish — not a raw dotted path", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <PromotionStatusLabel status="exam-eligible" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Elegible para examen")).toBeInTheDocument();
    expect(screen.queryByText(/dashboard\.status/)).not.toBeInTheDocument();
  });
});
