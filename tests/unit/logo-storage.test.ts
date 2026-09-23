import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  process.env.SUPABASE_LOGO_BUCKET = "org-branding";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

const { uploadLogo, deleteLogoByUrl } = await import("../../src/lib/branding/logo-storage");

function mockFetchOnce(impl: (url: string, init: RequestInit) => Promise<Response> | never) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}

/** `body` omitted -> `.json()` rejects, exactly like a non-JSON/empty
 * response body, so a test using this exercises the HTTP-status fallback,
 * never the provider-code path. */
function fakeResponse(status: number, ok: boolean, body?: unknown): Response {
  return {
    ok,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  } as unknown as Response;
}

describe("uploadLogo — HTTP-status fallback (no recognizable provider error code)", () => {
  it.each([
    [401, "permissionDenied"],
    [403, "permissionDenied"],
    [404, "bucketMissing"],
    [429, "storageRateLimited"],
    [500, "storageUnavailable"],
    [503, "storageUnavailable"],
  ] as const)("REQUIRED: a %s response with no parseable body falls back to %s", async (status, expected) => {
    mockFetchOnce(async () => fakeResponse(status, false));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: expected, status });
  });

  it("REQUIRED: an unrecognized provider code falls back to the HTTP status, not a guess from the code", async () => {
    mockFetchOnce(async () => fakeResponse(404, false, { code: "SomeFutureErrorCode", message: "not yet known to this module" }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({
      ok: false,
      error: "bucketMissing",
      status: 404,
      providerCode: "SomeFutureErrorCode",
      providerMessage: "not yet known to this module",
    });
  });
});

describe("uploadLogo — real Supabase Storage error codes (docs: supabase.com/docs/guides/storage/debugging/error-codes)", () => {
  it("REQUIRED: NoSuchBucket (404) classifies as bucketMissing", async () => {
    mockFetchOnce(async () => fakeResponse(404, false, { code: "NoSuchBucket", message: "The specified bucket does not exist." }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({
      ok: false,
      error: "bucketMissing",
      status: 404,
      providerCode: "NoSuchBucket",
      providerMessage: "The specified bucket does not exist.",
    });
  });

  it("REQUIRED: TenantNotFound (404) classifies as storageUnavailable, NOT bucketMissing — same status as NoSuchBucket, a different problem", async () => {
    mockFetchOnce(async () => fakeResponse(404, false, { code: "TenantNotFound", message: "The specified tenant does not exist." }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("storageUnavailable");
      expect(result.providerCode).toBe("TenantNotFound");
    }
  });

  it("REQUIRED: SlowDown (503) classifies as storageRateLimited, NOT storageUnavailable — a throttling signal, not a generic failure", async () => {
    mockFetchOnce(async () => fakeResponse(503, false, { code: "SlowDown", message: "The request rate is too high and has been throttled." }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("storageRateLimited");
      expect(result.providerCode).toBe("SlowDown");
    }
  });

  it("REQUIRED: InvalidJWT (401) classifies as permissionDenied", async () => {
    mockFetchOnce(async () => fakeResponse(401, false, { code: "InvalidJWT", message: "The provided JWT is invalid." }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("permissionDenied");
  });

  it("REQUIRED: AccessDenied (403) classifies as permissionDenied", async () => {
    mockFetchOnce(async () => fakeResponse(403, false, { code: "AccessDenied", message: "Access to the specified resource is denied." }));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("permissionDenied");
  });
});

describe("uploadLogo — never throws", () => {
  it("REQUIRED: a missing SUPABASE_URL classifies as storageUnavailable instead of throwing", async () => {
    delete process.env.SUPABASE_URL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: a missing SUPABASE_SERVICE_ROLE_KEY classifies as storageUnavailable instead of throwing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: a network failure (no HTTP status at all) classifies as storageUnavailable", async () => {
    mockFetchOnce(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
  });

  it("REQUIRED: an aborted (timed out) request classifies as storageUnavailable", async () => {
    mockFetchOnce(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
  });
});

describe("uploadLogo — success path", () => {
  it("a successful upload returns the object path and public URL", async () => {
    mockFetchOnce(async () => fakeResponse(200, true));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.path).toMatch(/^org-1\/\d+\.png$/);
      expect(result.result.url).toBe(`https://fake.supabase.co/storage/v1/object/public/org-branding/${result.result.path}`);
    }
  });
});

describe("deleteLogoByUrl", () => {
  const existingUrl = "https://fake.supabase.co/storage/v1/object/public/org-branding/org-1/123.png";

  it("a URL with no recognizable object marker is refused without calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await deleteLogoByUrl("https://unrelated.example.com/not-a-logo-url.png");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: a successful delete returns ok:true", async () => {
    mockFetchOnce(async () => fakeResponse(200, true));
    const result = await deleteLogoByUrl(existingUrl);
    expect(result).toEqual({ ok: true });
  });

  it("REQUIRED: a failed delete preserves the classified error and status, never throws", async () => {
    mockFetchOnce(async () => fakeResponse(403, false, { code: "AccessDenied", message: "Access to the specified resource is denied." }));
    const result = await deleteLogoByUrl(existingUrl);
    expect(result).toEqual({
      ok: false,
      error: "permissionDenied",
      status: 403,
      providerCode: "AccessDenied",
      providerMessage: "Access to the specified resource is denied.",
    });
  });

  it("REQUIRED: a missing SUPABASE_URL classifies as storageUnavailable instead of throwing — a committed removal must never crash on cleanup", async () => {
    delete process.env.SUPABASE_URL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await deleteLogoByUrl(existingUrl);
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: a missing SUPABASE_SERVICE_ROLE_KEY classifies as storageUnavailable instead of throwing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await deleteLogoByUrl(existingUrl);
    expect(result).toEqual({ ok: false, error: "storageUnavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
