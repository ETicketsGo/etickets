-- An organizer's own name for the kind of event, for "Other event type". Nullable and additive:
-- existing events keep their category and show it exactly as before.
ALTER TABLE "Event" ADD COLUMN "typeLabel" TEXT;
