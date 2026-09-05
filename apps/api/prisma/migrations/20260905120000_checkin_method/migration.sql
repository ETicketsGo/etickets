-- How a ticket was identified when it was admitted.
--
-- Defaults to SCAN, because every row that exists was one: scanning was the only way in when
-- they were written. Backfilling them as anything else would put a claim in the record that
-- nobody made.
CREATE TYPE "CheckInMethod" AS ENUM ('SCAN', 'VISUAL');

ALTER TABLE "CheckIn" ADD COLUMN "method" "CheckInMethod" NOT NULL DEFAULT 'SCAN';
