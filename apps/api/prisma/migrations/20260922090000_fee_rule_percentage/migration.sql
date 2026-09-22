-- Let a booking-fee band charge a percentage of the order as well as a fixed amount.
--
-- Requested by the owner: "Rs 100 to Rs 200 should collect Rs 10, but above Rs 5,000 I should be
-- able to choose 5%", with limits. Bands are still ranges of the order amount; each band now
-- says HOW it charges.
--
-- Purely additive. Every existing row becomes FLAT through the column default, so each one keeps
-- charging exactly the amount it charged before this migration, and an older API ignores the new
-- columns entirely. The percentage and its optional floor and ceiling are nullable because they
-- mean nothing on a FLAT band.

CREATE TYPE "FeeRuleType" AS ENUM ('FLAT', 'PERCENT');

ALTER TABLE "FeeRule"
  ADD COLUMN "feeType"       "FeeRuleType" NOT NULL DEFAULT 'FLAT',
  ADD COLUMN "feePercentBps" INTEGER,
  ADD COLUMN "minFeeMinor"   INTEGER,
  ADD COLUMN "maxFeeMinor"   INTEGER;
