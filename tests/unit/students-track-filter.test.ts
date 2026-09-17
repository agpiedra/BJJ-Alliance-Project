import { describe, expect, it } from "vitest";
import { parseTrack } from "@/lib/students/parse-track";
import { Track } from "@/generated/prisma/client";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-iii: the roster's track filter is
 * a URL search param, validated server-side — same rule 3c-i already
 * established for this file's other filters, "never trust what came in on
 * the request." `undefined` means Todos (no filter), and is also the
 * fallback for anything unrecognized — never one of the two real tracks,
 * unlike `parseStatus`'s ACTIVE fallback elsewhere in this same file.
 */
describe("parseTrack", () => {
  it("returns undefined (Todos) when the param is absent", () => {
    expect(parseTrack(undefined)).toBeUndefined();
  });

  it("passes through a real Track value", () => {
    expect(parseTrack("KIDS")).toBe(Track.KIDS);
    expect(parseTrack("ADULT")).toBe(Track.ADULT);
  });

  it("REQUIRED REGRESSION: falls back to undefined (Todos), not a guess, for any unrecognized value", () => {
    expect(parseTrack("kids")).toBeUndefined(); // wrong case
    expect(parseTrack("STUDENT")).toBeUndefined();
    expect(parseTrack("' OR 1=1")).toBeUndefined();
    expect(parseTrack("")).toBeUndefined();
  });
});
