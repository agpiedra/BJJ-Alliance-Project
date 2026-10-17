import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md §2.6 / §2.8 — the email helper's classified outcome (Resend mocked; no network) and
 * the reset flow's allow-listed logging.
 */
const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => sendMock(...args) };
  },
}));

const { sendTransactionalEmail, classifyProviderError } = await import("../../src/lib/email/send-transactional-email");
const { safeErrorCode, logPasswordResetEvent } = await import("../../src/lib/auth/password-reset-log");

describe("sendTransactionalEmail — classified outcome", () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_FROM", "MATROOM <noreply@example.test>");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepted only when the provider returns no error — success keeps its existing meaning", async () => {
    sendMock.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    expect(await sendTransactionalEmail("a@example.test", "s", ["l"])).toEqual({ success: true, outcome: "accepted" });
  });

  it("REQUIRED: a client-side provider code is a rejection, with only the fixed code kept", async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad 'to' a@example.test" } });
    const result = await sendTransactionalEmail("a@example.test", "s", ["l"]);
    expect(result).toMatchObject({ success: false, outcome: "rejected", providerCode: "validation_error" });
  });

  it("REQUIRED: provider-side errors leave acceptance unknown — never 'rejected'", async () => {
    for (const name of ["internal_server_error", "application_error", "concurrent_idempotent_requests"]) {
      sendMock.mockResolvedValue({ data: null, error: { name, message: "x" } });
      expect(await sendTransactionalEmail("a@example.test", "s", ["l"])).toMatchObject({ outcome: "unknown", providerCode: name });
    }
  });

  it("REQUIRED: an unrecognized provider code is unknown, and the code itself is not kept", async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: "something_new a@example.test", message: "x" } });
    const result = await sendTransactionalEmail("a@example.test", "s", ["l"]);
    expect(result.outcome).toBe("unknown");
    expect(result.providerCode).toBeUndefined();
  });

  it("REQUIRED: a thrown network failure is unknown", async () => {
    sendMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await sendTransactionalEmail("a@example.test", "s", ["l"])).toMatchObject({ success: false, outcome: "unknown" });
  });

  it("missing configuration is not_configured and makes no provider call", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendTransactionalEmail("a@example.test", "s", ["l"])).toMatchObject({ success: false, outcome: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("classifyProviderError ignores non-string names", () => {
    expect(classifyProviderError(undefined)).toEqual({ outcome: "unknown", providerCode: undefined });
    expect(classifyProviderError(42)).toEqual({ outcome: "unknown", providerCode: undefined });
  });
});

describe("password-reset logging", () => {
  it("REQUIRED: only Prisma codes and allow-listed class names pass; everything else becomes the fixed fallback", () => {
    expect(safeErrorCode({ code: "P2002", message: "secret@example.test" })).toBe("P2002");
    expect(safeErrorCode(new TypeError("token=abc"))).toBe("TypeError");
    expect(safeErrorCode(Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError" }))).toBe("PrismaClientKnownRequestError");
    expect(safeErrorCode(new Error("secret"))).toBe("unrecognized_error");
    expect(safeErrorCode({ name: "secret@example.test" })).toBe("unrecognized_error");
    expect(safeErrorCode({ code: "P2002; DROP" })).toBe("unrecognized_error");
    expect(safeErrorCode("a raw string")).toBe("unrecognized_error");
    expect(safeErrorCode(null)).toBe("unrecognized_error");
  });

  it("writes exactly the given fixed-shape entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logPasswordResetEvent({ event: "password_reset.email", outcome: "unknown" });
    expect(warn).toHaveBeenCalledWith("[password-reset]", { event: "password_reset.email", outcome: "unknown" });
    warn.mockRestore();
  });
});
