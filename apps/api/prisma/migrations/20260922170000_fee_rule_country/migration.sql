-- Give every booking-fee band the country it was always for.
--
-- The bands were seeded with the wildcard scope, so the admin console listed them as applying
-- "Everywhere". Each of these currencies belongs to exactly one of the platform's markets, so
-- that was never true. It also broke pricing: once one India-scoped band was added beside the
-- national INR schedule, the wildcard bands stopped applying in India and an order that fell
-- in one of their ranges was charged under the wrong band.
--
-- Only wildcard rows are touched, and only for currencies with exactly one market. A band
-- somebody has already scoped by hand is left exactly as they set it.
UPDATE "FeeRule" SET "country" = 'India'          WHERE "country" = '*' AND "currency" = 'INR';
UPDATE "FeeRule" SET "country" = 'United States'  WHERE "country" = '*' AND "currency" = 'USD';
UPDATE "FeeRule" SET "country" = 'Canada'         WHERE "country" = '*' AND "currency" = 'CAD';
UPDATE "FeeRule" SET "country" = 'United Kingdom' WHERE "country" = '*' AND "currency" = 'GBP';
UPDATE "FeeRule" SET "country" = 'United Arab Emirates' WHERE "country" = '*' AND "currency" = 'AED';
UPDATE "FeeRule" SET "country" = 'Singapore'      WHERE "country" = '*' AND "currency" = 'SGD';
UPDATE "FeeRule" SET "country" = 'Australia'      WHERE "country" = '*' AND "currency" = 'AUD';
UPDATE "FeeRule" SET "country" = 'New Zealand'    WHERE "country" = '*' AND "currency" = 'NZD';
