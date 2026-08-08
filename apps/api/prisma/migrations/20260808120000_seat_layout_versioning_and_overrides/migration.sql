-- Seat layout versioning + show-level seat overrides.
--
-- Backward compatible by construction. Every existing row keeps working without being
-- rewritten: current seat maps become version 1 / PUBLISHED, and every existing show is
-- backfilled to the layout it was already using. No data is deleted or moved.
--
-- The one structural change is dropping the one-seat-map-per-screen unique index. Relaxing
-- a uniqueness constraint cannot invalidate existing rows, so an older API instance still
-- running against this schema continues to behave exactly as before.

-- ── Enums ────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SeatLayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SeatOverrideKind" AS ENUM (
    'MANUAL_BLOCK', 'MAINTENANCE', 'HOUSE', 'VIP', 'COMPANION', 'EMERGENCY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── SeatMap becomes a version ────────────────────────────────────────────────────
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "status" "SeatLayoutStatus" NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "clonedFromId" TEXT;
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);
ALTER TABLE "SeatMap" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- Existing maps are already in use by real shows, so they are published, not drafts.
-- Dating them from their own creation keeps effective-version resolution monotonic.
UPDATE "SeatMap"
   SET "publishedAt" = COALESCE("publishedAt", "createdAt"),
       "effectiveFrom" = COALESCE("effectiveFrom", "createdAt")
 WHERE "publishedAt" IS NULL OR "effectiveFrom" IS NULL;

-- One layout per screen -> many versions per screen.
DROP INDEX IF EXISTS "SeatMap_screenId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SeatMap_screenId_version_key" ON "SeatMap"("screenId", "version");
CREATE INDEX IF NOT EXISTS "SeatMap_screenId_status_idx" ON "SeatMap"("screenId", "status");

DO $$ BEGIN
  ALTER TABLE "SeatMap"
    ADD CONSTRAINT "SeatMap_clonedFromId_fkey"
    FOREIGN KEY ("clonedFromId") REFERENCES "SeatMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Shows pin their layout version ───────────────────────────────────────────────
ALTER TABLE "EventSession" ADD COLUMN IF NOT EXISTS "seatMapId" TEXT;

DO $$ BEGIN
  ALTER TABLE "EventSession"
    ADD CONSTRAINT "EventSession_seatMapId_fkey"
    FOREIGN KEY ("seatMapId") REFERENCES "SeatMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill from the seats each show already materialised. This is the authoritative answer
-- rather than a guess: a session's ShowSeat rows point at Seat rows, and those seats belong
-- to exactly one layout. Sessions with no seats (general-admission events) stay NULL.
UPDATE "EventSession" es
   SET "seatMapId" = sub."seatMapId"
  FROM (
    SELECT DISTINCT ON (ss."eventSessionId") ss."eventSessionId", s."seatMapId"
      FROM "ShowSeat" ss
      JOIN "Seat" s ON s."id" = ss."seatId"
  ) AS sub
 WHERE es."id" = sub."eventSessionId"
   AND es."seatMapId" IS NULL;

-- ── Show-level seat overrides ────────────────────────────────────────────────────
ALTER TABLE "ShowSeat" ADD COLUMN IF NOT EXISTS "overrideKind" "SeatOverrideKind";
ALTER TABLE "ShowSeat" ADD COLUMN IF NOT EXISTS "overrideReason" TEXT;
ALTER TABLE "ShowSeat" ADD COLUMN IF NOT EXISTS "overrideByUserId" TEXT;
ALTER TABLE "ShowSeat" ADD COLUMN IF NOT EXISTS "overrideAt" TIMESTAMP(3);
ALTER TABLE "ShowSeat" ADD COLUMN IF NOT EXISTS "overrideExpiresAt" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "ShowSeat"
    ADD CONSTRAINT "ShowSeat_overrideByUserId_fkey"
    FOREIGN KEY ("overrideByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ShowSeat_eventSessionId_overrideKind_idx"
  ON "ShowSeat"("eventSessionId", "overrideKind");
-- Drives the maintenance auto-expiry sweep, which scans by deadline across all sessions.
CREATE INDEX IF NOT EXISTS "ShowSeat_overrideExpiresAt_idx"
  ON "ShowSeat"("overrideExpiresAt");
