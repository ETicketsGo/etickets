-- The logo table becomes the pictures table: a cover banner has the same rules as a profile
-- picture (same formats, same sniffing, same serving headers) and only a different size cap,
-- so it is a second row rather than a second table.
ALTER TABLE "OrganizationLogo" RENAME TO "OrganizationImage";
ALTER TABLE "OrganizationImage" RENAME CONSTRAINT "OrganizationLogo_pkey" TO "OrganizationImage_pkey";
ALTER TABLE "OrganizationImage" RENAME CONSTRAINT "OrganizationLogo_organizationId_fkey" TO "OrganizationImage_organizationId_fkey";

ALTER TABLE "OrganizationImage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'LOGO';

-- One picture of each kind per organization, instead of one picture per organization.
DROP INDEX "OrganizationLogo_organizationId_key";
CREATE UNIQUE INDEX "OrganizationImage_organizationId_kind_key"
    ON "OrganizationImage"("organizationId", "kind");
