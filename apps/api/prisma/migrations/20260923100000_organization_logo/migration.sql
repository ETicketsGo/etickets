-- An organization's profile picture, held by the platform rather than linked from wherever
-- the organizer could find to host one. Its own table so the bytes are never dragged into
-- the organization reads the console makes on every page.
CREATE TABLE "OrganizationLogo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationLogo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationLogo_organizationId_key" ON "OrganizationLogo"("organizationId");

ALTER TABLE "OrganizationLogo" ADD CONSTRAINT "OrganizationLogo_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
