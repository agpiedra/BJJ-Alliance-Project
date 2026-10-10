import { describe, expect, it, vi } from "vitest";
import { cleanupDisposableOrgFixture, type DisposableOrgFixtureClient } from "../helpers/fixture-cleanup";

function mockClient(): DisposableOrgFixtureClient {
  return {
    organizationMembership: { deleteMany: vi.fn().mockResolvedValue(undefined) },
    academy: { deleteMany: vi.fn().mockResolvedValue(undefined) },
    promotionConfig: { deleteMany: vi.fn().mockResolvedValue(undefined) },
    beltRank: { deleteMany: vi.fn().mockResolvedValue(undefined) },
    organizationBranding: { deleteMany: vi.fn().mockResolvedValue(undefined) },
    organization: { delete: vi.fn().mockResolvedValue(undefined) },
    user: { delete: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("cleanupDisposableOrgFixture", () => {
  it("REQUIRED: both ids undefined (setup failed before either was created) — no delete call executes at all", async () => {
    const client = mockClient();
    await cleanupDisposableOrgFixture(client, { organizationId: undefined, userId: undefined });

    expect(client.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(client.academy.deleteMany).not.toHaveBeenCalled();
    expect(client.promotionConfig.deleteMany).not.toHaveBeenCalled();
    expect(client.beltRank.deleteMany).not.toHaveBeenCalled();
    expect(client.organizationBranding.deleteMany).not.toHaveBeenCalled();
    expect(client.organization.delete).not.toHaveBeenCalled();
    expect(client.user.delete).not.toHaveBeenCalled();
  });

  it("REQUIRED: a blank organization id is treated the same as undefined — no unscoped delete executes", async () => {
    const client = mockClient();
    await cleanupDisposableOrgFixture(client, { organizationId: "", userId: undefined });

    expect(client.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(client.organization.delete).not.toHaveBeenCalled();
  });

  it("REQUIRED: organization created but user creation failed — organization cleanup still runs, scoped to the real id; user.delete is skipped, not called with undefined", async () => {
    const client = mockClient();
    await cleanupDisposableOrgFixture(client, { organizationId: "org-123", userId: undefined });

    expect(client.organizationMembership.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.academy.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.promotionConfig.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.beltRank.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.organizationBranding.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.organization.delete).toHaveBeenCalledWith({ where: { id: "org-123" } });
    expect(client.user.delete).not.toHaveBeenCalled();
  });

  it("REQUIRED: user created but organization creation failed — user cleanup still runs, scoped to the real id; no organization-scoped delete is called with undefined", async () => {
    const client = mockClient();
    await cleanupDisposableOrgFixture(client, { organizationId: undefined, userId: "user-456" });

    expect(client.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(client.academy.deleteMany).not.toHaveBeenCalled();
    expect(client.organization.delete).not.toHaveBeenCalled();
    expect(client.user.delete).toHaveBeenCalledWith({ where: { id: "user-456" } });
  });

  it("REQUIRED: both ids present (the ordinary success path) — every scoped delete runs with the real ids", async () => {
    const client = mockClient();
    await cleanupDisposableOrgFixture(client, { organizationId: "org-123", userId: "user-456" });

    expect(client.organizationMembership.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-123" } });
    expect(client.organization.delete).toHaveBeenCalledWith({ where: { id: "org-123" } });
    expect(client.user.delete).toHaveBeenCalledWith({ where: { id: "user-456" } });
  });
});
