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

function fakeResponse(status: number, ok: boolean): Response {
  return { ok, status, text: async () => "" } as unknown as Response;
}

describe("uploadLogo — status classification", () => {
  it.each([
    [401, "permissionDenied"],
    [403, "permissionDenied"],
    [404, "bucketMissing"],
    [429, "storageRateLimited"],
    [500, "storageUnavailable"],
    [503, "storageUnavailable"],
  ] as const)("REQUIRED: a %s response classifies as %s", async (status, expected) => {
    mockFetchOnce(async () => fakeResponse(status, false));
    const result = await uploadLogo("org-1", Buffer.from("bytes"), "image/png");
    expect(result).toEqual({ ok: false, error: expected, status });
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
  it("a URL with no recognizable object marker is refused without calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await deleteLogoByUrl("https://unrelated.example.com/not-a-logo-url.png");
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: a successful delete returns ok:true", async () => {
    mockFetchOnce(async () => fakeResponse(200, true));
    const result = await deleteLogoByUrl("https://fake.supabase.co/storage/v1/object/public/org-branding/org-1/123.png");
    expect(result).toEqual({ ok: true });
  });

  it("REQUIRED: a failed delete returns ok:false, never throws", async () => {
    mockFetchOnce(async () => fakeResponse(403, false));
    const result = await deleteLogoByUrl("https://fake.supabase.co/storage/v1/object/public/org-branding/org-1/123.png");
    expect(result).toEqual({ ok: false });
  });
});
