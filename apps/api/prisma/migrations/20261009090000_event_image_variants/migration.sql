-- Event images: web-ready copies, cut around a focal point the organizer chooses.
--
-- Additive only. Both new columns are nullable and mean "the middle" when null, so every image
-- uploaded before this keeps its meaning. An image with no copies yet is served from its
-- original exactly as before, and gets its copies the first time one is asked for.

ALTER TABLE "EventImage" ADD COLUMN "focalX" DOUBLE PRECISION;
ALTER TABLE "EventImage" ADD COLUMN "focalY" DOUBLE PRECISION;

-- A point outside the picture is not a point in it. Held here as well as in the API because a
-- seed or a backfill writes these rows too.
ALTER TABLE "EventImage" ADD CONSTRAINT "EventImage_focal_point_in_range"
    CHECK (("focalX" IS NULL OR ("focalX" >= 0 AND "focalX" <= 1))
       AND ("focalY" IS NULL OR ("focalY" >= 0 AND "focalY" <= 1)));

CREATE TABLE "EventImageVariant" (
    "id"          TEXT NOT NULL,
    "imageId"     TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "width"       INTEGER NOT NULL,
    "height"      INTEGER NOT NULL,
    "bytes"       BYTEA,
    "storageKey"  TEXT,
    "sizeBytes"   INTEGER NOT NULL,
    "sha256"      TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventImageVariant_pkey" PRIMARY KEY ("id")
);

-- One copy of each kind per image. A retried or concurrent cut lands on this and is skipped.
CREATE UNIQUE INDEX "EventImageVariant_imageId_name_key" ON "EventImageVariant"("imageId", "name");

-- Removing an image removes its copies with it.
ALTER TABLE "EventImageVariant" ADD CONSTRAINT "EventImageVariant_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "EventImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of `bytes` and `storageKey`, as on EventImage.
ALTER TABLE "EventImageVariant" ADD CONSTRAINT "EventImageVariant_bytes_or_key"
    CHECK (("bytes" IS NOT NULL) <> ("storageKey" IS NOT NULL));
