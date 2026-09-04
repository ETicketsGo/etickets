-- Correcting the regulatory configuration, and closing the hole that made a guess possible.
--
-- 1. A maintenance treatment can now be genuinely UNKNOWN. The Telangana seed carried
--    ADDED as an engineering assumption because the schema offered no way to say otherwise;
--    a schema that cannot express uncertainty forces somebody to invent a value.
-- 2. Special Theatre is a distinct class in the Andhra Pradesh rate table.
-- 3. A government order gets its own row, so ~26 AP rules cite one document rather than
--    twenty-six copies of a string that can drift apart.

ALTER TYPE "MaintenanceTreatment" ADD VALUE 'UNCONFIRMED';
ALTER TYPE "CinemaFormat" ADD VALUE 'SPECIAL_THEATRE';

CREATE TABLE "RegulatoryDocument" (
  "id"           TEXT NOT NULL,
  "reference"    TEXT NOT NULL,
  "country"      TEXT NOT NULL,
  "region"       TEXT NOT NULL DEFAULT '*',
  "documentUrl"  TEXT,
  -- Whether the full text has actually been read, as opposed to transcribed from a brief.
  -- A launch decision needs to tell those two states apart.
  "textReviewed" BOOLEAN NOT NULL DEFAULT false,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegulatoryDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegulatoryDocument_reference_key" ON "RegulatoryDocument"("reference");
CREATE INDEX "RegulatoryDocument_country_region_idx" ON "RegulatoryDocument"("country", "region");

ALTER TABLE "CinemaPricingPolicy" ADD COLUMN "regulatoryDocumentId" TEXT;
ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_regulatoryDocumentId_fkey"
  FOREIGN KEY ("regulatoryDocumentId") REFERENCES "RegulatoryDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
