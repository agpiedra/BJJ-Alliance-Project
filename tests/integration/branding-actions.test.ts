import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { hashSecret } from "../../src/lib/crypto";
import type { StorageFailure, UploadedLogo } from "../../src/lib/branding/logo-storage";

type UploadLogoResult = { ok: true; result: UploadedLogo } | StorageFailure;
type DeleteLogoResult = { ok: true } | StorageFailure;

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

// No real Supabase credentials in this dev/test environment — mocked the
// same way this codebase already mocks other external services (e.g. a
// fake Resend client for email tests). The upload/delete ORDERING itself
// (item 1) is what these tests verify, not the real network call. The
// discriminated-result shape matches logo-storage.ts's real return type
// (PR 1 — both functions used to throw/return void; a real storage failure
// is now a classified, never-thrown result, tested separately below).
const uploadLogoMock = vi.fn<(organizationId: string, bytes: Buffer, mimeType: string) => Promise<UploadLogoResult>>(
  async (organizationId, _bytes, mimeType) => ({
    ok: true,
    result: {
      path: `${organizationId}/fake.${mimeType === "image/png" ? "png" : "jpg"}`,
      url: `https://fake.supabase.co/storage/v1/object/public/org-branding/${organizationId}/fake-${Date.now()}.png`,
    },
  }),
);
const deleteLogoByUrlMock = vi.fn<(url: string) => Promise<DeleteLogoResult>>(async () => ({ ok: true }));
vi.mock("@/lib/branding/logo-storage", () => ({
  uploadLogo: (...args: [string, Buffer, string]) => uploadLogoMock(...args),
  deleteLogoByUrl: (...args: [string]) => deleteLogoByUrlMock(...args),
}));

const { saveBrandingTheme, uploadBrandingLogo, removeBrandingLogo } = await import(
  "../../src/app/[locale]/(staff)/admin/branding/actions"
);

const prisma = getTestPrismaClient();

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function fileFormData(fields: Record<string, string>, file: { name: string; bytes: Buffer; type: string }): FormData {
  const fd = formData(fields);
  fd.set("logo", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return fd;
}

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

const cleanupUserIds: string[] = [];
const cleanupOrgIds: string[] = [];

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupOrgIds.length > 0) {
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  }
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string, organizationId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: { email: `${label}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role },
  });
  cleanupUserIds.push(user.id);
  const orgId = organizationId ?? (await getAllianceOrganizationId());
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: orgId, role } });
  return { ...user, organizationId: orgId };
}

/** A fresh scratch organization per test that mutates OrganizationBranding
 * — never the shared seeded Alliance row, which other test files (and this
 * suite's own sibling files) read concurrently under vitest's cross-file
 * parallelism. */
async function makeScratchOrg(label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const org = await prisma.organization.create({
    data: { slug: `${label}-${suffix}`, name: `${label} Org ${suffix}`, status: "ACTIVE" },
  });
  cleanupOrgIds.push(org.id);
  return org;
}

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();
}

describe("saveBrandingTheme", () => {
  afterAll(cleanup);
  beforeEach(() => {
    currentSession = null;
  });

  it("an ADMIN saves colors, and the change is audited", async () => {
    const org = await makeScratchOrg("branding-save-admin");
    const admin = await makeStaffUser("ADMIN", "branding-save-admin", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const result = await saveBrandingTheme(
      org.id,
      {},
      formData({ displayName: "Test Academy", primaryColor: "#215DA5", sidebarBackground: "#0B2545" }),
    );
    expect(result.ok).toBe(true);

    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.primaryColor).toBe("#215DA5");
    expect(row.sidebarBackground).toBe("#0B2545");

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: org.id, action: "organizationBranding.updateTheme" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(admin.id);
    expect(audits[0].academyId).toBeNull();
  });

  it("a DIRECTOR can also save colors — matches the doc's ADMIN/DIRECTOR settings-page gate", async () => {
    const org = await makeScratchOrg("branding-save-director");
    const director = await makeStaffUser("DIRECTOR", "branding-save-director", org.id);
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: org.id };

    const result = await saveBrandingTheme(
      org.id,
      {},
      formData({ primaryColor: "#FACC15", sidebarBackground: "#111827" }),
    );
    expect(result.ok).toBe(true);
  });

  it("an INSTRUCTOR is rejected (FORBIDDEN thrown, a genuine member with the wrong role)", async () => {
    const org = await makeScratchOrg("branding-save-instructor");
    const instructor = await makeStaffUser("INSTRUCTOR", "branding-save-instructor", org.id);
    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: org.id };

    await expect(
      saveBrandingTheme(org.id, {}, formData({ primaryColor: "#FACC15", sidebarBackground: "#111827" })),
    ).rejects.toThrow("FORBIDDEN");
  });

  it("rejects an invalid hex color, writing nothing", async () => {
    const org = await makeScratchOrg("branding-save-invalid-hex");
    const admin = await makeStaffUser("ADMIN", "branding-save-invalid-hex", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const result = await saveBrandingTheme(org.id, {}, formData({ primaryColor: "not-a-color", sidebarBackground: "#111827" }));
    expect(result.error).toBe("invalid");
    expect(await prisma.organizationBranding.findUnique({ where: { organizationId: org.id } })).toBeNull();
  });

  it("REQUIRED: blocks an illegible explicit sidebar override before saving, with a corrected suggestion — the sidebar's block-not-warn rule enforced server-side", async () => {
    const org = await makeScratchOrg("branding-save-contrast-block");
    const admin = await makeStaffUser("ADMIN", "branding-save-contrast-block", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const result = await saveBrandingTheme(
      org.id,
      {},
      formData({
        primaryColor: "#FACC15",
        sidebarBackground: "#111827",
        sidebarForeground: "#222222", // near-black on near-black — fails AA
      }),
    );
    expect(result.error).toBe("sidebarContrast");
    expect(result.fieldErrors?.foreground?.[0]).toContain("#");
    expect(await prisma.organizationBranding.findUnique({ where: { organizationId: org.id } })).toBeNull();
  });

  it("a legible explicit sidebar override saves successfully", async () => {
    const org = await makeScratchOrg("branding-save-contrast-ok");
    const admin = await makeStaffUser("ADMIN", "branding-save-contrast-ok", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const result = await saveBrandingTheme(
      org.id,
      {},
      formData({ primaryColor: "#FACC15", sidebarBackground: "#111827", sidebarForeground: "#FFFFFF" }),
    );
    expect(result.ok).toBe(true);
    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.sidebarForeground).toBe("#FFFFFF");
  });
});

describe("uploadBrandingLogo / removeBrandingLogo", () => {
  afterAll(cleanup);
  beforeEach(() => {
    currentSession = null;
    uploadLogoMock.mockClear();
    deleteLogoByUrlMock.mockClear();
  });

  it("REQUIRED: upload -> DB write -> delete-old-object, in that exact order", async () => {
    const org = await makeScratchOrg("branding-logo-order");
    const admin = await makeStaffUser("ADMIN", "branding-logo-order", org.id);
    await prisma.organizationBranding.create({
      data: { organizationId: org.id, logoUrl: "https://fake.supabase.co/storage/v1/object/public/org-branding/old.png" },
    });
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const png = await tinyPng();
    const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: png, type: "image/png" }));
    expect(result.ok).toBe(true);

    expect(uploadLogoMock).toHaveBeenCalledTimes(1);
    expect(deleteLogoByUrlMock).toHaveBeenCalledTimes(1);
    expect(deleteLogoByUrlMock).toHaveBeenCalledWith("https://fake.supabase.co/storage/v1/object/public/org-branding/old.png");
    // The delete call happened, but only AFTER the upload mock resolved —
    // vi.fn call order across two different mocks is exactly what proves
    // the sequencing, not just that both were eventually called.
    const uploadOrder = uploadLogoMock.mock.invocationCallOrder[0];
    const deleteOrder = deleteLogoByUrlMock.mock.invocationCallOrder[0];
    expect(uploadOrder).toBeLessThan(deleteOrder);

    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.logoUrl).not.toBe("https://fake.supabase.co/storage/v1/object/public/org-branding/old.png");

    const audits = await prisma.auditLog.findMany({ where: { organizationId: org.id, action: "organizationBranding.logoUpload" } });
    expect(audits).toHaveLength(1);
  });

  it("rejects a renamed non-image file even with an image Content-Type claim", async () => {
    const org = await makeScratchOrg("branding-logo-fake-image");
    const admin = await makeStaffUser("ADMIN", "branding-logo-fake-image", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const notReallyAnImage = Buffer.from("MZ\x90\x00this is not a real image, just text pretending to be one");
    const result = await uploadBrandingLogo(
      org.id,
      {},
      fileFormData({}, { name: "totally-a-logo.png", bytes: notReallyAnImage, type: "image/png" }),
    );
    expect(result.error).toBe("invalidImage");
    expect(uploadLogoMock).not.toHaveBeenCalled();
  });

  it("rejects a file over 512 KB", async () => {
    const org = await makeScratchOrg("branding-logo-too-large");
    const admin = await makeStaffUser("ADMIN", "branding-logo-too-large", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const big = Buffer.alloc(600 * 1024, 0);
    const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "big.png", bytes: big, type: "image/png" }));
    expect(result.error).toBe("tooLarge");
  });

  it("rejects a wildly-wrong aspect ratio (beyond 5:1)", async () => {
    const org = await makeScratchOrg("branding-logo-aspect-ratio");
    const admin = await makeStaffUser("ADMIN", "branding-logo-aspect-ratio", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const tooWide = await sharp({ create: { width: 1000, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "wide.png", bytes: tooWide, type: "image/png" }));
    expect(result.error).toBe("extremeAspectRatio");
  });

  it("REQUIRED: a DIRECTOR can upload a logo — the settings page's own ADMIN/DIRECTOR gate was the correct one (PR 1)", async () => {
    const org = await makeScratchOrg("branding-logo-director-upload");
    const director = await makeStaffUser("DIRECTOR", "branding-logo-director-upload", org.id);
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: org.id };

    const result = await uploadBrandingLogo(
      org.id,
      {},
      fileFormData({}, { name: "logo.png", bytes: await tinyPng(), type: "image/png" }),
    );
    expect(result.ok).toBe(true);
    expect(uploadLogoMock).toHaveBeenCalledTimes(1);
  });

  it("a DIRECTOR of a DIFFERENT organization is still refused (the widening is per-membership, not global)", async () => {
    const org = await makeScratchOrg("branding-logo-cross-org-a");
    const otherOrg = await makeScratchOrg("branding-logo-cross-org-b");
    const director = await makeStaffUser("DIRECTOR", "branding-logo-cross-org", otherOrg.id);
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: otherOrg.id };

    const result = await uploadBrandingLogo(
      org.id,
      {},
      fileFormData({}, { name: "logo.png", bytes: await tinyPng(), type: "image/png" }),
    );
    expect(result.error).toBe("notFound");
    expect(uploadLogoMock).not.toHaveBeenCalled();
  });

  it("an INSTRUCTOR is still rejected (FORBIDDEN thrown, a genuine member with the wrong role)", async () => {
    const org = await makeScratchOrg("branding-logo-instructor-blocked");
    const instructor = await makeStaffUser("INSTRUCTOR", "branding-logo-instructor-blocked", org.id);
    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: org.id };

    await expect(
      uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: await tinyPng(), type: "image/png" })),
    ).rejects.toThrow("FORBIDDEN");
    expect(uploadLogoMock).not.toHaveBeenCalled();
  });

  it("REQUIRED: an empty submission renders as a distinct, translatable error, not the generic fallback", async () => {
    const org = await makeScratchOrg("branding-logo-empty-submit");
    const admin = await makeStaffUser("ADMIN", "branding-logo-empty-submit", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };

    const result = await uploadBrandingLogo(org.id, {}, formData({}));
    expect(result.error).toBe("invalid");
    expect(result.fieldErrors?.logo).toEqual(["required"]);
    expect(uploadLogoMock).not.toHaveBeenCalled();
  });

  it.each([
    ["permissionDenied", 403],
    ["bucketMissing", 404],
    ["storageRateLimited", 429],
    ["storageUnavailable", 500],
  ] as const)("REQUIRED: a %s storage failure is returned as that error, never thrown", async (error, status) => {
    const org = await makeScratchOrg(`branding-logo-storage-${error}`);
    const admin = await makeStaffUser("ADMIN", `branding-logo-storage-${error}`, org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };
    uploadLogoMock.mockResolvedValueOnce({ ok: false, error, status });

    const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: await tinyPng(), type: "image/png" }));
    expect(result.error).toBe(error);
    const row = await prisma.organizationBranding.findUnique({ where: { organizationId: org.id } });
    expect(row).toBeNull();
  });

  it("REQUIRED: an old-object cleanup failure after a successful replace is logged, never returned as an error", async () => {
    const org = await makeScratchOrg("branding-logo-cleanup-failure");
    const admin = await makeStaffUser("ADMIN", "branding-logo-cleanup-failure", org.id);
    await prisma.organizationBranding.create({
      data: { organizationId: org.id, logoUrl: "https://fake.supabase.co/storage/v1/object/public/org-branding/old.png" },
    });
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };
    deleteLogoByUrlMock.mockResolvedValueOnce({
      ok: false,
      error: "permissionDenied",
      status: 403,
      providerCode: "AccessDenied",
      providerMessage: "Access to the specified resource is denied.",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: await tinyPng(), type: "image/png" }));

    expect(result.ok).toBe(true);
    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.logoUrl).not.toBe("https://fake.supabase.co/storage/v1/object/public/org-branding/old.png");
    expect(errorSpy).toHaveBeenCalledWith(
      "[branding] old logo object left orphaned after a successful replace",
      expect.objectContaining({
        organizationId: org.id,
        error: "permissionDenied",
        status: 403,
        providerCode: "AccessDenied",
      }),
    );
    errorSpy.mockRestore();
  });

  it("REQUIRED: is rate-limited after repeated uploads in a short window", async () => {
    const org = await makeScratchOrg("branding-logo-rate-limit");
    const admin = await makeStaffUser("ADMIN", "branding-logo-rate-limit", org.id);
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };
    const png = await tinyPng();

    for (let i = 0; i < 10; i++) {
      const result = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: png, type: "image/png" }));
      expect(result.ok).toBe(true);
    }

    const eleventh = await uploadBrandingLogo(org.id, {}, fileFormData({}, { name: "logo.png", bytes: png, type: "image/png" }));
    expect(eleventh.error).toBe("rateLimited");
  });

  it("REQUIRED: a director can remove a logo, returning to the initials fallback", async () => {
    const org = await makeScratchOrg("branding-logo-remove");
    // A prior version of this test instantiated an ADMIN here despite the
    // title — passing while asserting nothing about directors at all. See
    // docs/MULTI_ACADEMY_AND_KIDS_BELTS.md's "masked by an overlapping
    // layer" tracking for this pattern; fixed by using the role the title
    // actually names.
    const director = await makeStaffUser("DIRECTOR", "branding-logo-remove", org.id);
    await prisma.organizationBranding.create({
      data: { organizationId: org.id, logoUrl: "https://fake.supabase.co/storage/v1/object/public/org-branding/existing.png" },
    });
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: org.id };

    const result = await removeBrandingLogo(org.id, {}, formData({}));
    expect(result.ok).toBe(true);

    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.logoUrl).toBeNull();
    expect(deleteLogoByUrlMock).toHaveBeenCalledWith("https://fake.supabase.co/storage/v1/object/public/org-branding/existing.png");

    const audits = await prisma.auditLog.findMany({ where: { organizationId: org.id, action: "organizationBranding.logoRemove" } });
    expect(audits).toHaveLength(1);
  });

  it("REQUIRED: a removal cleanup failure still reports success — the reference is already cleared", async () => {
    const org = await makeScratchOrg("branding-logo-remove-cleanup-failure");
    const admin = await makeStaffUser("ADMIN", "branding-logo-remove-cleanup-failure", org.id);
    await prisma.organizationBranding.create({
      data: { organizationId: org.id, logoUrl: "https://fake.supabase.co/storage/v1/object/public/org-branding/existing.png" },
    });
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: org.id };
    deleteLogoByUrlMock.mockResolvedValueOnce({
      ok: false,
      error: "bucketMissing",
      status: 404,
      providerCode: "NoSuchBucket",
      providerMessage: "The specified bucket does not exist.",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await removeBrandingLogo(org.id, {}, formData({}));

    expect(result.ok).toBe(true);
    const row = await prisma.organizationBranding.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(row.logoUrl).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[branding] logo object left orphaned after a successful removal",
      expect.objectContaining({
        organizationId: org.id,
        error: "bucketMissing",
        status: 404,
        providerCode: "NoSuchBucket",
      }),
    );
    errorSpy.mockRestore();
  });
});
