/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAttempt, readAttempt, clearAttempt, listStoredAttemptIds, type StoredAttemptPayload } from "../../src/lib/dues/payment-attempt-storage";

/**
 * Ordinary payment-entry UI brief §8 tier 4: the `localStorage` persistence module, per §2.4b/§2.4c's corrected
 * rules — write-once per key, storage failure BLOCKS submission (no "proceed anyway"), a corrupted entry is
 * preserved and flagged (never auto-cleared, never "start fresh"), per-key isolation across submissionIds.
 */

const ORG = "org-1";
const USER = "user-1";

const PAYLOAD: StoredAttemptPayload = {
  studentId: "student-1",
  obligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 3, day: 10 },
  tender: { currency: "USD", amount: "100.00" },
  method: "EFECTIVO",
  notes: "a note",
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("beginAttempt / readAttempt: a valid round-trip", () => {
  it("writes then reads back the identical payload", () => {
    expect(beginAttempt(ORG, USER, "sub-1", PAYLOAD)).toEqual({ ok: true });
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "ok", payload: PAYLOAD });
  });

  it("a missing key reads as missing", () => {
    expect(readAttempt(ORG, USER, "no-such-sub")).toEqual({ status: "missing" });
  });
});

describe("write-once per submissionId (§2.4b point 2 — edited form fields can never overwrite a stored payload)", () => {
  it("a second beginAttempt under the SAME key is refused, never silently overwriting", () => {
    expect(beginAttempt(ORG, USER, "sub-1", PAYLOAD)).toEqual({ ok: true });
    const edited = { ...PAYLOAD, tender: { currency: "USD" as const, amount: "999.00" } };
    expect(beginAttempt(ORG, USER, "sub-1", edited)).toEqual({ ok: false, error: "alreadyExists" });
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "ok", payload: PAYLOAD });
  });

  it("clearing frees the key for reuse", () => {
    beginAttempt(ORG, USER, "sub-1", PAYLOAD);
    clearAttempt(ORG, USER, "sub-1");
    expect(beginAttempt(ORG, USER, "sub-1", PAYLOAD)).toEqual({ ok: true });
  });
});

describe("corrupted/malformed stored values: preserved and flagged, never auto-cleared, never 'start fresh'", () => {
  it("a non-JSON stored value reads as corrupt, not missing, and the key is left alone", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, "{not json");
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
    expect(window.localStorage.getItem(`payment-attempt:${ORG}:${USER}:sub-1`)).toBe("{not json");
  });

  it("a well-formed JSON value failing the schema reads as corrupt, never thrown back un-validated", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, JSON.stringify({ studentId: "s1" })); // missing required fields
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
  });

  it("the submissionId is still discoverable via a key scan even when the stored VALUE is fully corrupt", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-corrupt`, "not even json {{{");
    expect(listStoredAttemptIds(ORG, USER)).toContain("sub-corrupt");
  });
});

describe("storage-write failure blocks submission entirely — no 'proceed anyway' path", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    setItemSpy = vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
  });
  afterEach(() => setItemSpy.mockRestore());

  it("beginAttempt returns storageUnavailable, surfaced BEFORE any network call would happen", () => {
    expect(beginAttempt(ORG, USER, "sub-1", PAYLOAD)).toEqual({ ok: false, error: "storageUnavailable" });
  });
});

describe("per-key isolation: two different submissionIds under the same user/org never clobber each other", () => {
  it("each attempt's own entry is independent", () => {
    const payloadB: StoredAttemptPayload = { ...PAYLOAD, studentId: "student-2" };
    beginAttempt(ORG, USER, "sub-a", PAYLOAD);
    beginAttempt(ORG, USER, "sub-b", payloadB);
    expect(readAttempt(ORG, USER, "sub-a")).toEqual({ status: "ok", payload: PAYLOAD });
    expect(readAttempt(ORG, USER, "sub-b")).toEqual({ status: "ok", payload: payloadB });
    clearAttempt(ORG, USER, "sub-a");
    expect(readAttempt(ORG, USER, "sub-a")).toEqual({ status: "missing" });
    expect(readAttempt(ORG, USER, "sub-b")).toEqual({ status: "ok", payload: payloadB });
  });

  it("different users/orgs never see each other's entries (listStoredAttemptIds is scoped)", () => {
    beginAttempt(ORG, USER, "sub-1", PAYLOAD);
    beginAttempt("org-2", USER, "sub-2", PAYLOAD);
    beginAttempt(ORG, "user-2", "sub-3", PAYLOAD);
    expect(listStoredAttemptIds(ORG, USER)).toEqual(["sub-1"]);
  });
});

describe("clearAttempt: removes exactly the targeted entry", () => {
  it("leaves other entries untouched", () => {
    beginAttempt(ORG, USER, "sub-1", PAYLOAD);
    beginAttempt(ORG, USER, "sub-2", PAYLOAD);
    clearAttempt(ORG, USER, "sub-1");
    expect(listStoredAttemptIds(ORG, USER).sort()).toEqual(["sub-2"]);
  });

  it("clearing a non-existent key is a safe no-op", () => {
    expect(() => clearAttempt(ORG, USER, "never-existed")).not.toThrow();
  });
});
