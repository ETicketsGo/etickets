-- India cinema pricing policy: a per-ticket statutory maintenance charge, an online-fee
-- posture and ticket-price limits, all as effective-dated configuration rather than code.
--
-- Every column added here is nullable or defaulted, so existing rows stay valid and every
-- non-cinema flow prices exactly as it did before. A jurisdiction only becomes regulated
-- when an ACTIVE policy row names it.

-- ── Classification and jurisdiction ────────────────────────────────────────────────
CREATE TYPE "LocalBodyType" AS ENUM ('MUNICIPAL_CORPORATION', 'MUNICIPALITY', 'NAGAR_PANCHAYAT', 'GRAM_PANCHAYAT', 'OTHER');
CREATE TYPE "CinemaFormat" AS ENUM ('MULTIPLEX', 'SINGLE_SCREEN');
CREATE TYPE "ClimateType" AS ENUM ('AC', 'AIR_COOLED', 'NON_AC');

-- ── Policy shape ───────────────────────────────────────────────────────────────────
CREATE TYPE "MaintenanceTreatment" AS ENUM ('NOT_APPLICABLE', 'INCLUDED_IN_TICKET_PRICE', 'ADDED_TO_TICKET_PRICE');
CREATE TYPE "OnlineFeePolicy" AS ENUM ('ALLOWED', 'CAPPED', 'INCLUDED_IN_TICKET_PRICE', 'PROHIBITED', 'REQUIRES_APPROVAL');
CREATE TYPE "CinemaPricingPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'DISABLED');
CREATE TYPE "PricingComplianceStatus" AS ENUM ('NOT_REGULATED', 'COMPLIANT', 'POLICY_NOT_FOUND', 'REQUIRES_APPROVAL', 'PRICE_EXCEEDS_LIMIT', 'ONLINE_FEE_NOT_ALLOWED', 'INVALID_CINEMA_CLASSIFICATION', 'POLICY_CONFIGURATION_ERROR');

-- A maintenance charge is taxed in its own right or not at all; that is a TaxRule's
-- decision, and this value is what such a rule targets.
ALTER TYPE "TaxBase" ADD VALUE 'MAINTENANCE';

-- ── Cinema gains jurisdiction + classification ─────────────────────────────────────
ALTER TABLE "Cinema" ADD COLUMN "country"       TEXT;
ALTER TABLE "Cinema" ADD COLUMN "region"        TEXT;
ALTER TABLE "Cinema" ADD COLUMN "district"      TEXT;
ALTER TABLE "Cinema" ADD COLUMN "localBodyType" "LocalBodyType";
ALTER TABLE "Cinema" ADD COLUMN "cinemaFormat"  "CinemaFormat";
ALTER TABLE "Cinema" ADD COLUMN "climateType"   "ClimateType";

-- ── The policy table ───────────────────────────────────────────────────────────────
CREATE TABLE "CinemaPricingPolicy" (
  "id"                     TEXT NOT NULL,
  "version"                INTEGER NOT NULL DEFAULT 1,
  "country"                TEXT NOT NULL DEFAULT '*',
  "region"                 TEXT NOT NULL DEFAULT '*',
  "district"               TEXT NOT NULL DEFAULT '*',
  "city"                   TEXT NOT NULL DEFAULT '*',
  "currency"               TEXT NOT NULL DEFAULT '*',
  "localBodyType"          "LocalBodyType",
  "cinemaFormat"           "CinemaFormat",
  "climateType"            "ClimateType",
  "seatCategory"           TEXT,
  "maintenanceChargeMinor" INTEGER NOT NULL DEFAULT 0,
  "maintenanceTreatment"   "MaintenanceTreatment" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "maintenanceTaxCategory" TEXT,
  "onlineFeePolicy"        "OnlineFeePolicy" NOT NULL DEFAULT 'REQUIRES_APPROVAL',
  "onlineFeeCapMinor"      INTEGER,
  "ticketPriceMinMinor"    INTEGER,
  "ticketPriceMaxMinor"    INTEGER,
  "ticketPriceRule"        TEXT,
  "status"                 "CinemaPricingPolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom"          TIMESTAMP(3) NOT NULL,
  "effectiveTo"            TIMESTAMP(3),
  "supersedesId"           TEXT,
  "regulatoryReference"    TEXT NOT NULL,
  "regulatoryDocumentUrl"  TEXT,
  "notes"                  TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CinemaPricingPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CinemaPricingPolicy_supersedesId_key" ON "CinemaPricingPolicy"("supersedesId");
CREATE INDEX "CinemaPricingPolicy_status_country_region_idx" ON "CinemaPricingPolicy"("status", "country", "region");
CREATE INDEX "CinemaPricingPolicy_status_effectiveFrom_idx" ON "CinemaPricingPolicy"("status", "effectiveFrom");
ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "CinemaPricingPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A CAPPED policy without a cap is an unlimited fee wearing a limit's name. Refused by the
-- database, not only by the service, because a bad row inserted any other way still prices
-- real orders.
ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_cap_required"
  CHECK ("onlineFeePolicy" <> 'CAPPED' OR "onlineFeeCapMinor" IS NOT NULL);

-- A charge with no treatment, or a treatment with no charge, is a half-written rule.
ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_maintenance_coherent"
  CHECK (
    ("maintenanceTreatment" = 'NOT_APPLICABLE' AND "maintenanceChargeMinor" = 0)
    OR ("maintenanceTreatment" <> 'NOT_APPLICABLE' AND "maintenanceChargeMinor" > 0)
  );

ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_price_band_ordered"
  CHECK ("ticketPriceMinMinor" IS NULL OR "ticketPriceMaxMinor" IS NULL OR "ticketPriceMinMinor" <= "ticketPriceMaxMinor");

ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_effective_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveFrom" < "effectiveTo");

-- ── Booking carries the snapshot ───────────────────────────────────────────────────
ALTER TABLE "Booking" ADD COLUMN "maintenanceMinor"       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "maintenanceTreatment"   "MaintenanceTreatment" NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE "Booking" ADD COLUMN "pricingPolicyId"        TEXT;
ALTER TABLE "Booking" ADD COLUMN "pricingPolicyVersion"   INTEGER;
ALTER TABLE "Booking" ADD COLUMN "pricingPolicyEffective" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "regulatoryReference"    TEXT;
ALTER TABLE "Booking" ADD COLUMN "pricingJurisdiction"    JSONB;
ALTER TABLE "Booking" ADD COLUMN "complianceStatus"       "PricingComplianceStatus" NOT NULL DEFAULT 'NOT_REGULATED';

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_pricingPolicyId_fkey"
  FOREIGN KEY ("pricingPolicyId") REFERENCES "CinemaPricingPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
