/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAttempt,
  readAttempt,
  readPackageAttempt,
  readPrepaymentAttempt,
  clearAttempt,
  listStoredAttemptIds,
  scanAttemptsByOperation,
  readStoredOperation,
  type StoredAttemptPayload,
  type StoredPackageAttemptPayload,
  type StoredPrepaymentAttemptPayload,
} from "../../src/lib/dues/payment-attempt-storage";

/**
 * Ordinary payment-entry UI brief §8 tier 4: the `localStorage` persistence module, per §2.4b/§2.4c's corrected
 * rules — write-once per key, storage failure BLOCKS submission (no "proceed anyway"), a corrupted entry is
 * preserved and flagged (never auto-cleared, never "start fresh"), per-key isolation across submissionIds.
 *
 * Post-review (point 5): `listStoredAttemptIds`/`readAttempt`/`clearAttempt` each now return a distinct
 * "unavailable" result when the underlying `localStorage` call itself throws — never silently identical to "missing"
 * / "nothing stored" / "successfully removed". The stored-payload schema is also strengthened to reject a
 * schema-valid-but-semantically-garbage value (bad method, unparseable amount, duplicate obligationIds, an
 * impossible calendar date).
 *
 * Package-purchase UI brief §2.6/§2.10: `operation` is now part of the stored payload (defaulted to `"ORDINARY"`
 * only for a key-absent, otherwise-valid legacy entry), and `scanAttemptsByOperation` is the new 3-way partition —
 * tested in full below alongside the pre-existing round-trip/corruption/isolation coverage above, unchanged.
 */

const ORG = "org-1";
const USER = "user-1";

const PAYLOAD: StoredAttemptPayload = {
  operation: "ORDINARY",
  studentId: "student-1",
  obligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 3, day: 10 },
  tender: { currency: "USD", amount: "100.00" },
  method: "EFECTIVO",
  notes: "a note",
};

const PACKAGE_PAYLOAD: StoredPackageAttemptPayload = {
  operation: "PACKAGE",
  studentId: "student-1",
  planTermsId: "terms-1",
  requestedStartMonth: { year: 2027, month: 4 },
  existingObligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 3, day: 10 },
  tender: { currency: "USD", amount: "250.00" },
  method: "EFECTIVO",
  notes: "a note",
};

const PREPAYMENT_PAYLOAD: StoredPrepaymentAttemptPayload = {
  operation: "PREPAYMENT",
  studentId: "student-1",
  requestedMonths: [{ year: 2027, month: 4 }, { year: 2027, month: 5 }],
  existingObligationIds: ["ob-1"],
  receivedOn: { year: 2027, month: 3, day: 10 },
  tender: { currency: "USD", amount: "200.00" },
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
    expect(clearAttempt(ORG, USER, "sub-1")).toEqual({ ok: true });
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
    const scanned = listStoredAttemptIds(ORG, USER);
    expect(scanned.status === "ok" && scanned.ids).toContain("sub-corrupt");
  });

  it("a schema-valid but semantically garbage value is also corrupt (point 5): bad method", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, JSON.stringify({ ...PAYLOAD, method: "BITCOIN" }));
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
  });

  it("a schema-valid but semantically garbage value is also corrupt: unparseable money amount", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, JSON.stringify({ ...PAYLOAD, tender: { currency: "USD", amount: "not-money" } }));
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
  });

  it("a schema-valid but semantically garbage value is also corrupt: duplicate obligationIds", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, JSON.stringify({ ...PAYLOAD, obligationIds: ["ob-1", "ob-1"] }));
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
  });

  it("a schema-valid but semantically garbage value is also corrupt: an impossible calendar date", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-1`, JSON.stringify({ ...PAYLOAD, receivedOn: { year: 2027, month: 2, day: 30 } }));
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "corrupt" });
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

describe("point 5: a storage-access failure is distinct from a genuinely empty/missing result, for all three read-path functions", () => {
  it("listStoredAttemptIds: a throwing scan returns {status:'unavailable'}, never {status:'ok', ids:[]}", () => {
    const spy = vi.spyOn(window.localStorage.__proto__, "key").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });
    // length must be nonzero for the loop to even reach `.key(i)`.
    window.localStorage.setItem("irrelevant", "x");
    try {
      expect(listStoredAttemptIds(ORG, USER)).toEqual({ status: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("listStoredAttemptIds: a genuinely empty storage still returns {status:'ok', ids:[]}, not unavailable", () => {
    expect(listStoredAttemptIds(ORG, USER)).toEqual({ status: "ok", ids: [] });
  });

  it("readAttempt: a throwing getItem returns {status:'unavailable'}, never {status:'missing'}", () => {
    const spy = vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });
    try {
      expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("clearAttempt: a throwing removeItem returns {ok:false, error:'unavailable'} — the caller must not assume the entry is gone", () => {
    const spy = vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });
    try {
      expect(clearAttempt(ORG, USER, "sub-1")).toEqual({ ok: false, error: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("clearAttempt: removing a genuinely-present key still returns {ok:true}", () => {
    beginAttempt(ORG, USER, "sub-1", PAYLOAD);
    expect(clearAttempt(ORG, USER, "sub-1")).toEqual({ ok: true });
    expect(readAttempt(ORG, USER, "sub-1")).toEqual({ status: "missing" });
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
    expect(listStoredAttemptIds(ORG, USER)).toEqual({ status: "ok", ids: ["sub-1"] });
  });
});

describe("clearAttempt: removes exactly the targeted entry", () => {
  it("leaves other entries untouched", () => {
    beginAttempt(ORG, USER, "sub-1", PAYLOAD);
    beginAttempt(ORG, USER, "sub-2", PAYLOAD);
    clearAttempt(ORG, USER, "sub-1");
    const scanned = listStoredAttemptIds(ORG, USER);
    expect(scanned.status === "ok" && scanned.ids.sort()).toEqual(["sub-2"]);
  });

  it("clearing a non-existent key is a safe no-op, returning ok:true", () => {
    expect(clearAttempt(ORG, USER, "never-existed")).toEqual({ ok: true });
  });
});

describe("operation discriminator: a legacy entry (no operation key, otherwise valid) defaults to ORDINARY", () => {
  it("readAttempt defaults a key-absent operation to ORDINARY", () => {
    const { operation, ...legacyPayload } = PAYLOAD;
    void operation;
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-legacy`, JSON.stringify(legacyPayload));
    expect(readAttempt(ORG, USER, "sub-legacy")).toEqual({ status: "ok", payload: PAYLOAD });
  });

  it("readStoredOperation: explicit operation trusted directly", () => {
    expect(readStoredOperation({ operation: "PACKAGE" })).toBe("PACKAGE");
    expect(readStoredOperation({ operation: "PREPAYMENT" })).toBe("PREPAYMENT");
  });

  it("readStoredOperation: a key-absent but otherwise-valid ordinary payload defaults to ORDINARY", () => {
    const { operation, ...legacyPayload } = PAYLOAD;
    void operation;
    expect(readStoredOperation(legacyPayload)).toBe("ORDINARY");
  });

  it("readStoredOperation: an invalid operation value, or a payload broken on any other field, is UNKNOWN — never silently ORDINARY (fail closed)", () => {
    expect(readStoredOperation({ operation: "BITCOIN" })).toBe("UNKNOWN");
    expect(readStoredOperation("not an object")).toBe("UNKNOWN");
    expect(readStoredOperation(null)).toBe("UNKNOWN");
    const { operation, ...legacyPayload } = PAYLOAD;
    void operation;
    expect(readStoredOperation({ ...legacyPayload, method: "BITCOIN" })).toBe("UNKNOWN");
  });
});

describe("readPackageAttempt: the package card's own counterpart to readAttempt", () => {
  it("writes then reads back the identical package payload", () => {
    expect(beginAttempt(ORG, USER, "sub-pkg-1", PACKAGE_PAYLOAD)).toEqual({ ok: true });
    expect(readPackageAttempt(ORG, USER, "sub-pkg-1")).toEqual({ status: "ok", payload: PACKAGE_PAYLOAD });
  });

  it("a missing key reads as missing", () => {
    expect(readPackageAttempt(ORG, USER, "no-such-sub")).toEqual({ status: "missing" });
  });

  it("an ORDINARY entry (disjoint shape, no PACKAGE literal match) reads as corrupt through readPackageAttempt — never cross-read", () => {
    beginAttempt(ORG, USER, "sub-ordinary", PAYLOAD);
    expect(readPackageAttempt(ORG, USER, "sub-ordinary")).toEqual({ status: "corrupt" });
  });

  it("a PACKAGE entry (disjoint shape) reads as corrupt through readAttempt — never cross-read", () => {
    beginAttempt(ORG, USER, "sub-pkg-2", PACKAGE_PAYLOAD);
    expect(readAttempt(ORG, USER, "sub-pkg-2")).toEqual({ status: "corrupt" });
  });
});

describe("readPrepaymentAttempt: the prepayment card's own counterpart to readAttempt/readPackageAttempt", () => {
  it("writes then reads back the identical prepayment payload", () => {
    expect(beginAttempt(ORG, USER, "sub-prepay-1", PREPAYMENT_PAYLOAD)).toEqual({ ok: true });
    expect(readPrepaymentAttempt(ORG, USER, "sub-prepay-1")).toEqual({ status: "ok", payload: PREPAYMENT_PAYLOAD });
  });

  it("a missing key reads as missing", () => {
    expect(readPrepaymentAttempt(ORG, USER, "no-such-sub")).toEqual({ status: "missing" });
  });

  it("a PACKAGE entry (disjoint shape) reads as corrupt through readPrepaymentAttempt — never cross-read", () => {
    beginAttempt(ORG, USER, "sub-pkg-3", PACKAGE_PAYLOAD);
    expect(readPrepaymentAttempt(ORG, USER, "sub-pkg-3")).toEqual({ status: "corrupt" });
  });

  it("a PREPAYMENT entry (disjoint shape) reads as corrupt through readPackageAttempt — never cross-read", () => {
    beginAttempt(ORG, USER, "sub-prepay-2", PREPAYMENT_PAYLOAD);
    expect(readPackageAttempt(ORG, USER, "sub-prepay-2")).toEqual({ status: "corrupt" });
  });

  it("duplicate requestedMonths entries are rejected as corrupt, mirroring duplicate obligationIds elsewhere", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-dup-months`, JSON.stringify({ ...PREPAYMENT_PAYLOAD, requestedMonths: [{ year: 2027, month: 4 }, { year: 2027, month: 4 }] }));
    expect(readPrepaymentAttempt(ORG, USER, "sub-dup-months")).toEqual({ status: "corrupt" });
  });
});

describe("scanAttemptsByOperation: the 3-way partition (package-purchase UI brief §2.10)", () => {
  it("an ORDINARY entry is 'matching' for operation ORDINARY, and 'otherOperations' for operation PACKAGE", () => {
    beginAttempt(ORG, USER, "sub-ord", PAYLOAD);
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: ["sub-ord"], otherOperations: [], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: [], otherOperations: ["sub-ord"], unclassifiable: [] });
  });

  it("a PACKAGE entry is 'matching' for operation PACKAGE, and 'otherOperations' for operation ORDINARY", () => {
    beginAttempt(ORG, USER, "sub-pkg", PACKAGE_PAYLOAD);
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: ["sub-pkg"], otherOperations: [], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: [], otherOperations: ["sub-pkg"], unclassifiable: [] });
  });

  it("a legacy entry (no operation key, otherwise genuinely a valid ordinary payload) is picked up ONLY by the ORDINARY filter, never by PACKAGE's exact-match filter", () => {
    const { operation, ...legacyPayload } = PAYLOAD;
    void operation;
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-legacy`, JSON.stringify(legacyPayload));
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: ["sub-legacy"], otherOperations: [], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: [], otherOperations: ["sub-legacy"], unclassifiable: [] });
  });

  it("corrupt JSON lands in 'unclassifiable', regardless of which operation is being scanned for", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-corrupt`, "not even json {{{");
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: [], otherOperations: [], unclassifiable: ["sub-corrupt"] });
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: [], otherOperations: [], unclassifiable: ["sub-corrupt"] });
  });

  it("a well-formed JSON value with an unrecognized operation value lands in 'unclassifiable' — never silently coerced to ORDINARY", () => {
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-badop`, JSON.stringify({ ...PACKAGE_PAYLOAD, operation: "BITCOIN" }));
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: [], otherOperations: [], unclassifiable: ["sub-badop"] });
  });

  it("a well-formed JSON value missing operation AND otherwise broken on another field lands in 'unclassifiable', never defaulted to ORDINARY", () => {
    const { operation, ...legacyPayload } = PAYLOAD;
    void operation;
    window.localStorage.setItem(`payment-attempt:${ORG}:${USER}:sub-broken`, JSON.stringify({ ...legacyPayload, method: "BITCOIN" }));
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: [], otherOperations: [], unclassifiable: ["sub-broken"] });
  });

  it("a per-entry getItem throw during an otherwise-successful enumeration lands THAT entry in 'unclassifiable', never aborting the whole scan", () => {
    beginAttempt(ORG, USER, "sub-ok", PAYLOAD);
    const key = (organizationId: string, userId: string, submissionId: string) => `payment-attempt:${organizationId}:${userId}:${submissionId}`;
    window.localStorage.setItem(key(ORG, USER, "sub-throws"), JSON.stringify(PAYLOAD));
    const realGetItem = window.localStorage.getItem.bind(window.localStorage);
    const spy = vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation((...args: unknown[]) => {
      const k = args[0] as string;
      if (k === key(ORG, USER, "sub-throws")) throw new Error("storage inaccessible for this one key");
      return realGetItem(k);
    });
    try {
      const result = scanAttemptsByOperation(ORG, USER, "ORDINARY");
      expect(result).toEqual({ status: "ok", matching: ["sub-ok"], otherOperations: [], unclassifiable: ["sub-throws"] });
    } finally {
      spy.mockRestore();
    }
  });

  it("a whole-scan key-enumeration failure is {status:'unavailable'}, identical to listStoredAttemptIds's own rule", () => {
    const spy = vi.spyOn(window.localStorage.__proto__, "key").mockImplementation(() => {
      throw new Error("storage inaccessible");
    });
    window.localStorage.setItem("irrelevant", "x");
    try {
      expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("a PREPAYMENT entry is 'matching' for operation PREPAYMENT, and 'otherOperations' for both ORDINARY and PACKAGE", () => {
    beginAttempt(ORG, USER, "sub-prepay", PREPAYMENT_PAYLOAD);
    expect(scanAttemptsByOperation(ORG, USER, "PREPAYMENT")).toEqual({ status: "ok", matching: ["sub-prepay"], otherOperations: [], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: [], otherOperations: ["sub-prepay"], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: [], otherOperations: ["sub-prepay"], unclassifiable: [] });
  });

  it("all three operations present simultaneously each land in their own 'matching' bucket and nowhere else", () => {
    beginAttempt(ORG, USER, "sub-ord-3", PAYLOAD);
    beginAttempt(ORG, USER, "sub-pkg-3b", PACKAGE_PAYLOAD);
    beginAttempt(ORG, USER, "sub-prepay-3", PREPAYMENT_PAYLOAD);
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: ["sub-ord-3"], otherOperations: ["sub-pkg-3b", "sub-prepay-3"], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "PACKAGE")).toEqual({ status: "ok", matching: ["sub-pkg-3b"], otherOperations: ["sub-ord-3", "sub-prepay-3"], unclassifiable: [] });
    expect(scanAttemptsByOperation(ORG, USER, "PREPAYMENT")).toEqual({ status: "ok", matching: ["sub-prepay-3"], otherOperations: ["sub-ord-3", "sub-pkg-3b"], unclassifiable: [] });
  });

  it("different users/orgs are excluded, exactly like listStoredAttemptIds", () => {
    beginAttempt(ORG, USER, "sub-mine", PAYLOAD);
    beginAttempt("org-2", USER, "sub-other-org", PAYLOAD);
    beginAttempt(ORG, "user-2", "sub-other-user", PAYLOAD);
    expect(scanAttemptsByOperation(ORG, USER, "ORDINARY")).toEqual({ status: "ok", matching: ["sub-mine"], otherOperations: [], unclassifiable: [] });
  });
});
