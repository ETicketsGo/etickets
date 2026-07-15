-- Human-readable booking references (ADR-030).

-- 1. Immutable, globally-unique public reference on Booking.
ALTER TABLE "Booking" ADD COLUMN "reference" TEXT;
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- 2. Per-(country, year) monotonic counter backing reference generation.
CREATE TABLE "BookingReferenceCounter" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BookingReferenceCounter_pkey" PRIMARY KEY ("scope")
);

-- 3. Backfill references for already-confirmed bookings so the new cross-portal
--    search works on historical data. Deterministic: partitioned by (country,
--    year) and ordered by confirmation time then id.
WITH cc(name, code) AS (
    VALUES
        ('india', 'IND'),
        ('united states', 'USA'),
        ('usa', 'USA'),
        ('united states of america', 'USA'),
        ('canada', 'CAN'),
        ('united kingdom', 'GBR'),
        ('uk', 'GBR'),
        ('australia', 'AUS'),
        ('united arab emirates', 'ARE'),
        ('uae', 'ARE'),
        ('singapore', 'SGP')
),
numbered AS (
    SELECT
        b.id,
        COALESCE(cc.code, 'INT') AS country,
        to_char(COALESCE(b."confirmedAt", b."createdAt"), 'YYYY') AS yr,
        row_number() OVER (
            PARTITION BY
                COALESCE(cc.code, 'INT'),
                to_char(COALESCE(b."confirmedAt", b."createdAt"), 'YYYY')
            ORDER BY COALESCE(b."confirmedAt", b."createdAt"), b.id
        ) AS rn
    FROM "Booking" b
    JOIN "Event" e ON e.id = b."eventId"
    JOIN "Venue" v ON v.id = e."venueId"
    LEFT JOIN cc ON cc.name = lower(v.country)
    WHERE b."confirmedAt" IS NOT NULL
)
UPDATE "Booking" b
SET "reference" = 'ETG-' || n.country || '-' || n.yr || '-' || lpad(n.rn::text, 6, '0')
FROM numbered n
WHERE n.id = b.id;

-- 4. Seed counters from the highest sequence per scope so runtime never collides.
INSERT INTO "BookingReferenceCounter" ("scope", "value", "updatedAt")
SELECT
    split_part("reference", '-', 2) || '-' || split_part("reference", '-', 3) AS scope,
    MAX(split_part("reference", '-', 4)::int) AS value,
    now()
FROM "Booking"
WHERE "reference" IS NOT NULL
GROUP BY 1;
