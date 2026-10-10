export interface DisposableOrgFixtureClient {
  organizationMembership: { deleteMany(args: { where: { organizationId: string } }): Promise<unknown> };
  academy: { deleteMany(args: { where: { organizationId: string } }): Promise<unknown> };
  promotionConfig: { deleteMany(args: { where: { organizationId: string } }): Promise<unknown> };
  beltRank: { deleteMany(args: { where: { organizationId: string } }): Promise<unknown> };
  organizationBranding: { deleteMany(args: { where: { organizationId: string } }): Promise<unknown> };
  organization: { delete(args: { where: { id: string } }): Promise<unknown> };
  user: { delete(args: { where: { id: string } }): Promise<unknown> };
}

/**
 * Guarded teardown for a disposable org+user browser-test fixture. Each half
 * is gated independently on its own id being a real, nonblank string —
 * Prisma silently strips an `undefined` filter value, so an unguarded
 * `deleteMany({ where: { organizationId: undefined } })` becomes
 * `deleteMany({ where: {} })`: unscoped, wiping the table for every
 * organization, seeded ones included. Setup can fail between creating the
 * organization and creating the user, so a successfully created org must
 * still be cleaned up even when the user never got created, and vice versa.
 */
export async function cleanupDisposableOrgFixture(
  client: DisposableOrgFixtureClient,
  ids: { organizationId: string | undefined; userId: string | undefined },
): Promise<void> {
  if (ids.organizationId) {
    await client.organizationMembership.deleteMany({ where: { organizationId: ids.organizationId } });
    await client.academy.deleteMany({ where: { organizationId: ids.organizationId } });
    await client.promotionConfig.deleteMany({ where: { organizationId: ids.organizationId } });
    await client.beltRank.deleteMany({ where: { organizationId: ids.organizationId } });
    await client.organizationBranding.deleteMany({ where: { organizationId: ids.organizationId } });
    await client.organization.delete({ where: { id: ids.organizationId } });
  }
  if (ids.userId) {
    await client.user.delete({ where: { id: ids.userId } });
  }
}
