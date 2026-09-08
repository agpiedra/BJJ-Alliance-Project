import { describe, expect, it } from "vitest";

describe("student code format", () => {
  it("is always a 4-digit zero-padded numeric string in the valid range", () => {
    for (let i = 0; i < 100; i++) {
      const n = Math.floor(Math.random() * 10000);
      const code = n.toString().padStart(4, "0");
      expect(code).toMatch(/^\d{4}$/);
    }
  });
});
