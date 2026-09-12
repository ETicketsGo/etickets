-- A fixed-amount coupon is an amount of money, and money has a currency.
--
-- A FIXED coupon's "value" is in minor units, but nothing recorded minor units OF WHAT: a
-- ₹500-off code took $500 off a US-dollar booking. Checkout now applies a FIXED coupon only to
-- bookings in the coupon's own currency.
--
-- Existing FIXED coupons are given the currency their organization sells in: the currency of the
-- country most of its venues are in, however the venue form spelled that country. The spellings
-- are the aliases `currencyForCountry` in @eticketsgo/shared-types accepts, so this backfill and
-- the API's own default agree (a unit test holds the two lists together). Ties go to the
-- alphabetically first currency so the result does not depend on row order. An organization
-- with no venue in a known country, and a platform-wide coupon with no organization, get INR,
-- the historic default. PERCENT coupons keep NULL: a percentage applies in any currency.
--
-- Only FIXED rows still without a currency are touched, so running the UPDATE again changes
-- nothing.

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "currency" TEXT;

-- Backfill
WITH "venue_currency" AS (
  SELECT
    v."organizationId",
    CASE
      WHEN LOWER(TRIM(v."country")) IN ('india', 'in') THEN 'INR'
      WHEN LOWER(TRIM(v."country")) IN ('united states', 'united states of america', 'usa', 'us') THEN 'USD'
      WHEN LOWER(TRIM(v."country")) IN ('canada', 'ca') THEN 'CAD'
      WHEN LOWER(TRIM(v."country")) IN ('united kingdom', 'great britain', 'uk', 'gb') THEN 'GBP'
      WHEN LOWER(TRIM(v."country")) IN ('united arab emirates', 'uae', 'ae') THEN 'AED'
      WHEN LOWER(TRIM(v."country")) IN ('singapore', 'sg') THEN 'SGD'
      WHEN LOWER(TRIM(v."country")) IN ('australia', 'au') THEN 'AUD'
      WHEN LOWER(TRIM(v."country")) IN ('new zealand', 'nz') THEN 'NZD'
    END AS "currency"
  FROM "Venue" AS v
),
"organization_currency" AS (
  SELECT DISTINCT ON ("organizationId") "organizationId", "currency"
  FROM "venue_currency"
  WHERE "currency" IS NOT NULL
  GROUP BY "organizationId", "currency"
  ORDER BY "organizationId", COUNT(*) DESC, "currency" ASC
)
UPDATE "Coupon" AS c
SET "currency" = COALESCE(
      (
        SELECT oc."currency"
        FROM "organization_currency" AS oc
        WHERE oc."organizationId" = c."organizationId"
      ),
      'INR'
    ),
    "updatedAt" = NOW()
WHERE c."type" = 'FIXED'
  AND c."currency" IS NULL;
