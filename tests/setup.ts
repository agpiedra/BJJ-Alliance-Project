import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom implements no ResizeObserver at all. A minimal no-op keeps every component that merely
// `observe()`s something from crashing render; a test asserting the OBSERVER'S OWN behavior
// (schedule-day-list.test.tsx) installs its own richer, trackable mock in its own `beforeEach`,
// which simply overrides this global for the duration of that file.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;
}
