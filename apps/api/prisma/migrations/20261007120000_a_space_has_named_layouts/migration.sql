-- A space may have several layouts at once, not one layout with several versions.
--
-- WHY --------------------------------------------------------------------------------
-- "SeatMap" was keyed on ("screenId", "version"), which encodes the assumption that a space
-- has ONE layout evolving over time. That is true of a cinema screen and false of every
-- larger venue: an arena's basketball bowl and its end-stage concert configuration are
-- different rooms built from the same building, not two versions of one.
--
-- Storing the second one was literally impossible - the insert failed on the unique key.
--
-- The name is now part of the identity, so a space has named configurations and each one
-- keeps its own version history, lineage and effective dating. A cinema has exactly one name
-- and is unaffected.

-- Existing rows may have no name. They are the single unnamed layout of their space, which is
-- what "Default" means here; nothing is reinterpreted beyond giving that case a word.
UPDATE "SeatMap" SET "name" = 'Default' WHERE "name" IS NULL;

ALTER TABLE "SeatMap" ALTER COLUMN "name" SET DEFAULT 'Default';
ALTER TABLE "SeatMap" ALTER COLUMN "name" SET NOT NULL;

DROP INDEX IF EXISTS "SeatMap_screenId_version_key";
CREATE UNIQUE INDEX "SeatMap_screenId_name_version_key" ON "SeatMap"("screenId", "name", "version");
