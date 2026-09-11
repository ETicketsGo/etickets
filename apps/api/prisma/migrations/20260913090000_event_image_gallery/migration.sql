-- An event can hold several images; the lowest position is the cover.
-- Existing rows (at most one per event until now) become position 0, the cover.
DROP INDEX "EventImage_eventId_key";

-- AlterTable
ALTER TABLE "EventImage" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "EventImage_eventId_position_idx" ON "EventImage"("eventId", "position");
