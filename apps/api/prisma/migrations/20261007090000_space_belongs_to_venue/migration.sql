-- A space belongs to a VENUE, not to a cinema.
--
-- WHY --------------------------------------------------------------------------------
-- "Screen" is the bookable space, and it could only reach its venue through "Cinema"
-- because "cinemaId" was NOT NULL. That one constraint is why an arena, an auditorium, a
-- concert hall and a conference room all had to be created as a cinema before they could
-- sell a numbered seat. This gives a space its own venue and makes the cinema optional.
--
-- SAFETY -----------------------------------------------------------------------------
-- Additive and reversible. Nothing is dropped, no column on "Cinema" is removed, and
-- "Screen"."venueId" stays nullable so a rolling deploy cannot meet a required column it
-- has not written yet. It is made required in a later migration, once every row has one
-- and the readers have shipped.

ALTER TABLE "Screen" ADD COLUMN "venueId" TEXT;

-- The cinema becomes optional. A cinema screen keeps its cinema and is unaffected.
ALTER TABLE "Screen" ALTER COLUMN "cinemaId" DROP NOT NULL;

ALTER TABLE "Screen"
  ADD CONSTRAINT "Screen_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Screen_venueId_idx" ON "Screen"("venueId");

-- 1. Every space whose cinema already has a venue inherits it.
UPDATE "Screen" s
   SET "venueId" = c."venueId"
  FROM "Cinema" c
 WHERE s."cinemaId" = c."id"
   AND c."venueId" IS NOT NULL
   AND s."venueId" IS NULL;

-- 2. A cinema with no venue gets one, built from the location it is already carrying.
--
--    Deterministic by construction: one venue per such cinema, keyed on the cinema's id, so
--    re-running cannot create a second. Nothing is invented - every value below is copied
--    from the row, and "Venue"."timezone"/"country" have defaults for the nulls. This is the
--    case the audit script reports as "no venue at all"; locally there are none, which is
--    why this is written to be correct rather than to be observed working here.
INSERT INTO "Venue" ("id", "organizationId", "name", "city", "country", "region",
                     "timezone", "address", "status", "createdAt", "updatedAt")
SELECT 'vn_' || c."id",
       c."organizationId",
       c."name",
       c."city",
       COALESCE(c."country", 'India'),
       c."region",
       c."timezone",
       c."address",
       'ACTIVE',
       NOW(),
       NOW()
  FROM "Cinema" c
 WHERE c."venueId" IS NULL
   AND EXISTS (SELECT 1 FROM "Screen" s WHERE s."cinemaId" = c."id")
   AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v."id" = 'vn_' || c."id");

-- 3. Point those cinemas, and their spaces, at the venue just created for them.
UPDATE "Cinema" c
   SET "venueId" = 'vn_' || c."id"
 WHERE c."venueId" IS NULL
   AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."id" = 'vn_' || c."id");

UPDATE "Screen" s
   SET "venueId" = c."venueId"
  FROM "Cinema" c
 WHERE s."cinemaId" = c."id"
   AND c."venueId" IS NOT NULL
   AND s."venueId" IS NULL;
