-- Approved legal identity: payouts are judged against fields only an independent staff
-- decision writes. Additive: new enum, new nullable columns, one defaulted column.
CREATE TYPE "LegalIdentityStatus" AS ENUM ('UNREVIEWED', 'APPROVED', 'PENDING_REVIEW', 'CHANGES_REQUESTED');

ALTER TABLE "Organization"
  ADD COLUMN "legalIdentityStatus" "LegalIdentityStatus" NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "approvedLegalName" TEXT,
  ADD COLUMN "approvedLegalEntityType" TEXT,
  ADD COLUMN "approvedRegisteredCountry" TEXT,
  ADD COLUMN "approvedTaxRegistrationKind" TEXT,
  ADD COLUMN "approvedTaxRegistrationNumber" TEXT,
  ADD COLUMN "legalIdentityApprovedAt" TIMESTAMP(3),
  ADD COLUMN "legalIdentityApprovedByUserId" TEXT,
  ADD COLUMN "legalIdentityChangedAt" TIMESTAMP(3),
  ADD COLUMN "legalIdentityChangedByUserId" TEXT,
  ADD COLUMN "legalIdentityReviewNote" TEXT;

-- Backfill, conservatively.
-- An organization whose payout-critical legal fields (name, form, country, tax identity) were
-- edited AFTER its (latest) approval never had the
-- current identity approved: it starts PENDING_REVIEW with no approved snapshot, so the edit
-- is never silently blessed and its payouts wait for a reviewer.
UPDATE "Organization" o
SET "legalIdentityStatus" = 'PENDING_REVIEW',
    "legalIdentityChangedAt" = (
      SELECT max(a."createdAt") FROM "AuditLog" a
      WHERE a."entityId" = o.id
        AND a.action IN ('ORGANIZATION_LEGAL_IDENTITY_UPDATED', 'ORGANIZATION_LEGAL_IDENTITY_UPDATED_BY_ADMIN')
        AND (a.metadata -> 'fields') ?| ARRAY['legalName', 'legalEntityType', 'registeredCountry', 'taxRegistrationKind', 'taxRegistrationNumber']),
    "legalIdentityChangedByUserId" = (
      SELECT a."actorUserId" FROM "AuditLog" a
      WHERE a."entityId" = o.id
        AND a.action IN ('ORGANIZATION_LEGAL_IDENTITY_UPDATED', 'ORGANIZATION_LEGAL_IDENTITY_UPDATED_BY_ADMIN')
        AND (a.metadata -> 'fields') ?| ARRAY['legalName', 'legalEntityType', 'registeredCountry', 'taxRegistrationKind', 'taxRegistrationNumber']
      ORDER BY a."createdAt" DESC LIMIT 1),
    "legalIdentityReviewNote" = 'Legal details changed after approval; recorded for review when this control was introduced.'
WHERE o.status IN ('APPROVED', 'SUSPENDED')
  AND EXISTS (
    SELECT 1 FROM "AuditLog" a
    WHERE a."entityId" = o.id
      AND a.action IN ('ORGANIZATION_LEGAL_IDENTITY_UPDATED', 'ORGANIZATION_LEGAL_IDENTITY_UPDATED_BY_ADMIN')
      AND (a.metadata -> 'fields') ?| ARRAY['legalName', 'legalEntityType', 'registeredCountry', 'taxRegistrationKind', 'taxRegistrationNumber']
      AND a."createdAt" > COALESCE(
        (SELECT max(b."createdAt") FROM "AuditLog" b
         WHERE b."entityId" = o.id AND b.action = 'ORGANIZATION_APPROVED'),
        '-infinity'::timestamp)
  );

-- Every other approved (or suspended) organization: the identity on file is the one approved.
UPDATE "Organization"
SET "legalIdentityStatus" = 'APPROVED',
    "approvedLegalName" = "legalName",
    "approvedLegalEntityType" = "legalEntityType",
    "approvedRegisteredCountry" = "registeredCountry",
    "approvedTaxRegistrationKind" = "taxRegistrationKind",
    "approvedTaxRegistrationNumber" = "taxRegistrationNumber",
    "legalIdentityApprovedAt" = now()
WHERE status IN ('APPROVED', 'SUSPENDED')
  AND "legalIdentityStatus" = 'UNREVIEWED';
