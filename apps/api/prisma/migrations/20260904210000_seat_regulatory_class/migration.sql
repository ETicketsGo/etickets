-- Which class of seat a regulator considers a seat category, as opposed to what it is called.
--
-- Nullable with no default and no backfill, on purpose. A default would hand every existing
-- seat category an answer nobody gave, and the whole point of the column is that the operator
-- states the mapping rather than the platform inferring it from a display name.
CREATE TYPE "SeatRegulatoryClass" AS ENUM ('REGULAR', 'RECLINER', 'PREMIUM', 'NON_PREMIUM');

ALTER TABLE "SeatCategory" ADD COLUMN "regulatoryClass" "SeatRegulatoryClass";
