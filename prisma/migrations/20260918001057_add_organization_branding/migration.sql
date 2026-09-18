-- CreateTable
CREATE TABLE "OrganizationBranding" (
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT,
    "logoUrl" TEXT,
    "logoMimeType" TEXT,
    "logoUpdatedAt" TIMESTAMP(3),
    "primaryColor" TEXT NOT NULL DEFAULT '#FACC15',
    "sidebarBackground" TEXT NOT NULL DEFAULT '#111827',
    "sidebarForeground" TEXT,
    "sidebarActiveBackground" TEXT,
    "sidebarActiveForeground" TEXT,
    "sidebarBorder" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationBranding_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "OrganizationBranding" ADD CONSTRAINT "OrganizationBranding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
