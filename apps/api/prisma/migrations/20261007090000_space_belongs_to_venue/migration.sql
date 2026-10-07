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

-- A historical API allowed a cinema to be pointed at a venue in another organization.
-- Such a relationship must never become authoritative Screen ownership. Abort before making
-- any schema or data change: the transaction leaves the database untouched and the ids in the
-- diagnostic are sufficient for a human, read-only audit and an explicitly authorised repair.
-- A database tenant-equality constraint is not added here because Screen has no organizationId
-- to participate in a composite foreign key. The service validates new associations; this guard
-- and the read-only audit script protect historical and directly-written data.
DO $$
DECLARE
  mismatches TEXT;
BEGIN
  SELECT STRING_AGG(c."id" || '->' || v."id", ', ' ORDER BY c."id")
    INTO mismatches
    FROM "Cinema" c
    JOIN "Venue" v ON v."id" = c."venueId"
   WHERE c."organizationId" <> v."organizationId";

  IF mismatches IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot assign authoritative Screen venues: Cinema/Venue organization mismatch(s): %',
      mismatches;
  END IF;
END $$;

-- The orphan-Cinema backfill below must be able to preserve "unknown". These columns were
-- originally NOT NULL with India defaults; make them answerable before inserting any copied
-- historical row. The dedicated location migration repeats these DROP operations so it stays
-- safe on databases that applied an earlier form of this migration during development.
ALTER TABLE "Venue" ALTER COLUMN "country" DROP NOT NULL;
ALTER TABLE "Venue" ALTER COLUMN "country" DROP DEFAULT;
ALTER TABLE "Venue" ALTER COLUMN "timezone" DROP NOT NULL;
ALTER TABLE "Venue" ALTER COLUMN "timezone" DROP DEFAULT;

ALTER TABLE "Screen" ADD COLUMN IF NOT EXISTS "venueId" TEXT;

-- The cinema becomes optional. A cinema screen keeps its cinema and is unaffected.
ALTER TABLE "Screen" ALTER COLUMN "cinemaId" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Screen_venueId_fkey'
      AND conrelid = '"Screen"'::regclass
  ) THEN
    ALTER TABLE "Screen"
      ADD CONSTRAINT "Screen_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Screen_venueId_idx" ON "Screen"("venueId");

-- 1. Every space whose cinema already has a venue inherits it.
UPDATE "Screen" s
   SET "venueId" = c."venueId"
  FROM "Cinema" c
 JOIN "Venue" v ON v."id" = c."venueId" AND v."organizationId" = c."organizationId"
 WHERE s."cinemaId" = c."id"
   AND c."venueId" IS NOT NULL
   AND s."venueId" IS NULL;

-- 2. A cinema with no venue gets one, built from the location it is already carrying.
--
--    Deterministic by construction: one venue per such cinema, keyed on the cinema's id, so
--    re-running cannot create a second. Nothing is invented: nullable location values remain
--    null. Unknown is not India, and may not be used to select currency, tax or regulation.
--    This is the case the audit script reports as "no venue at all"; locally there are none,
--    which is why this is written to be correct rather than to be observed working here.
INSERT INTO "Venue" ("id", "organizationId", "name", "city", "country", "region",
                     "timezone", "address", "status", "createdAt", "updatedAt")
SELECT 'vn_' || c."id",
       c."organizationId",
       c."name",
       c."city",
       c."country",
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
  JOIN "Venue" v ON v."id" = c."venueId" AND v."organizationId" = c."organizationId"
 WHERE s."cinemaId" = c."id"
   AND c."venueId" IS NOT NULL
   AND s."venueId" IS NULL;
