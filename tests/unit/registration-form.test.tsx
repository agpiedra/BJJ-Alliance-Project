/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The slug availability feedback under the registration form's URL field. It must describe ONLY the current valid slug
 * (2-60 characters): never an "Available" or "taken" left over from an earlier slug, never anything for an empty or
 * one-character slug, and never a late answer for a slug the person has already moved away from. The availability check is a
 * server action; here it is a controllable promise, so answers can be delivered late and out of order.
 */
const pending = vi.hoisted(() => [] as Array<{ slug: string; answer: (available: boolean) => void }>);
vi.mock("../../src/app/[locale]/register-academy/actions", () => ({
  registerOrganization: vi.fn(async () => ({})),
  checkSlugAvailability: vi.fn((slug: string) => new Promise((resolve) => pending.push({ slug, answer: (available: boolean) => resolve({ available }) }))),
}));

const { RegistrationForm } = await import("../../src/app/[locale]/register-academy/registration-form");

const COPY = {
  en: { messages: enMessages, checking: "Checking availability…", available: "Available", taken: "That URL is already taken" },
  es: { messages: esMessages, checking: "Verificando disponibilidad…", available: "Disponible", taken: "Esa URL ya está en uso" },
} as const;

function mount(locale: "en" | "es") {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={COPY[locale].messages}>
      <RegistrationForm />
    </NextIntlClientProvider>,
  );
  const name = view.container.querySelector('input[name="organizationName"]') as HTMLInputElement;
  const slug = view.container.querySelector('input[name="desiredSlug"]') as HTMLInputElement;
  const copy = COPY[locale];
  return {
    name, slug,
    typeName: (v: string) => act(async () => { fireEvent.change(name, { target: { value: v } }); }),
    typeSlug: (v: string) => act(async () => { fireEvent.change(slug, { target: { value: v } }); }),
    /** Deliver the answer to the `nth` (0 = oldest) still-unanswered check for `slugValue`. */
    answer: (slugValue: string, available: boolean, nth = 0) => act(async () => { const i = pending.map((p, at) => (p.slug === slugValue ? at : -1)).filter((at) => at >= 0)[nth]; pending.splice(i, 1)[0].answer(available); }),
    feedback: () => (screen.queryByText(copy.checking) ? "checking" : screen.queryByText(copy.available) ? "available" : screen.queryByText(copy.taken) ? "taken" : "none"),
  };
}

describe.each(["en", "es"] as const)("registration form slug feedback (%s)", (locale) => {
  beforeEach(() => { pending.length = 0; });
  afterEach(cleanup);

  it("shows the current slug's result, and nothing once the name shortens the slug below 2 characters", async () => {
    const f = mount(locale);
    await f.typeName("Harbor Test Academy");
    expect(f.slug.value).toBe("harbor-test-academy");
    expect(f.feedback()).toBe("checking");
    await f.answer("harbor-test-academy", true);
    expect(f.feedback()).toBe("available");
    await f.typeName("H");
    expect(f.slug.value).toBe("h");
    expect(f.feedback()).toBe("none"); // was a stale "Available" for "h"
    expect(pending).toHaveLength(0); // and no check was made for a one-character slug
  });

  it("shows nothing when the name is cleared (empty slug)", async () => {
    const f = mount(locale);
    await f.typeName("Harbor");
    await f.answer("harbor", true);
    await f.typeName("");
    expect(f.slug.value).toBe("");
    expect(f.feedback()).toBe("none");
  });

  it("does not leave a stale 'taken' when a taken slug is shortened", async () => {
    const f = mount(locale);
    await f.typeName("Alliance Cr");
    await f.answer("alliance-cr", false);
    expect(f.feedback()).toBe("taken");
    await f.typeName("A");
    expect(f.feedback()).toBe("none");
  });

  it("a late answer for an earlier slug is ignored when the slug is no longer valid", async () => {
    const f = mount(locale);
    await f.typeSlug("alliance-cr"); // check in flight
    await f.typeSlug("a"); // the person moves on to a one-character slug
    expect(f.feedback()).toBe("none");
    await f.answer("alliance-cr", false); // the slow answer finally arrives
    expect(f.feedback()).toBe("none");
  });

  it("a late answer for an earlier VALID slug is never shown for the current slug", async () => {
    const f = mount(locale);
    await f.typeSlug("alliance-cr");
    await f.typeSlug("harbor-zzz-free");
    await f.answer("alliance-cr", false); // old answer arrives first
    expect(f.feedback()).toBe("checking"); // still waiting for the current slug's own answer, not "taken"
    await f.answer("harbor-zzz-free", true);
    expect(f.feedback()).toBe("available");
  });

  it("request A then B, B answered first: A's late answer does not overwrite B's result", async () => {
    const f = mount(locale);
    await f.typeSlug("harbor-aaa");
    await f.typeSlug("harbor-bbb");
    await f.answer("harbor-bbb", true);
    expect(f.feedback()).toBe("available");
    await f.answer("harbor-aaa", false); // superseded response arrives last
    expect(f.feedback()).toBe("available");
    // and the other polarity: B taken must not be flipped by A's "available"
    await f.typeSlug("harbor-ccc");
    await f.typeSlug("harbor-ddd");
    await f.answer("harbor-ddd", false);
    await f.answer("harbor-ccc", true);
    expect(f.feedback()).toBe("taken");
  });

  it("A, edit to B, back to A: only the latest of the two A requests governs (either arrival order)", async () => {
    const f = mount(locale);
    await f.typeSlug("harbor-aaa"); // A#1
    await f.typeSlug("harbor-bbb");
    await f.typeSlug("harbor-aaa"); // A#2, the latest
    await f.answer("harbor-aaa", true, 0); // A#1 (earlier) says available
    expect(f.feedback()).toBe("checking"); // the earlier A result must not stand in for the new check
    await f.answer("harbor-bbb", true);
    expect(f.feedback()).toBe("checking");
    await f.answer("harbor-aaa", false, 0); // A#2 says taken
    expect(f.feedback()).toBe("taken");

    // reverse arrival: the latest answers first, the superseded one later
    await f.typeSlug("harbor-eee"); // E#1
    await f.typeSlug("harbor-fff");
    await f.typeSlug("harbor-eee"); // E#2
    await f.answer("harbor-eee", false, 1); // E#2 (latest) says taken
    expect(f.feedback()).toBe("taken");
    await f.answer("harbor-eee", true, 0); // E#1 (superseded) arrives late
    expect(f.feedback()).toBe("taken");
  });

  it("re-requesting the slug already on screen invalidates its result until the new answer arrives", async () => {
    const f = mount(locale);
    await f.typeName("Harbor");
    await f.answer("harbor", true);
    expect(f.feedback()).toBe("available");
    await f.typeName("Harbor!"); // a different name, the same slug: a new check starts
    expect(f.slug.value).toBe("harbor");
    expect(f.feedback()).toBe("checking");
    await f.answer("harbor", false);
    expect(f.feedback()).toBe("taken");
  });

  it("hand-editing the slug down to one character or to nothing clears the feedback too", async () => {
    const f = mount(locale);
    await f.typeSlug("harbor-check");
    await f.answer("harbor-check", true);
    expect(f.feedback()).toBe("available");
    await f.typeSlug("h");
    expect(f.feedback()).toBe("none");
    await f.typeSlug("");
    expect(f.feedback()).toBe("none");
  });

  it("a slug of the maximum valid length (slugify cuts longer input to 60) is checked and reported", async () => {
    const f = mount(locale);
    await f.typeSlug("a".repeat(61));
    expect(f.slug.value).toHaveLength(60);
    await f.answer("a".repeat(60), true);
    expect(f.feedback()).toBe("available");
  });
});
