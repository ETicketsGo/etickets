-- Readable references for support requests: ETG-SUP-<YEAR>-<SEQ>, e.g. ETG-SUP-2026-000142.
--
-- The problem (production emails, 2026-10): the acknowledgement said "Your reference is
-- cmvncaxg10015uo2zxo94825e" - a database id nobody can read out on the phone.
--
-- Additive and backward compatible, in this order:
--   1. a NULLABLE column with a unique index (an older API inserts without it and keeps working);
--   2. a counter table, one row per scope ('SUP-2026'), and the one function that increments it;
--   3. a BEFORE INSERT trigger that fills the reference for any insert that does not carry one,
--      so rows written by the OLD API during the rollout window get a reference too;
--   4. an idempotent backfill of existing rows, numbered per UTC year in createdAt order;
--   5. the counters seeded from the highest number in use, so new references continue after.
-- No existing column, constraint or row identity changes. Feedback.id stays the primary key.
-- Nothing about bookings changes: BookingReferenceCounter is not touched.

-- 1. The column. Unique: one reference names one request.
ALTER TABLE "Feedback" ADD COLUMN "reference" TEXT;
CREATE UNIQUE INDEX "Feedback_reference_key" ON "Feedback"("reference");

-- Only ever the one shape: ETG-SUP-, a four digit year, a dash, at least six digits.
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_reference_shape"
  CHECK ("reference" IS NULL OR "reference" ~ '^ETG-SUP-[0-9]{4}-[0-9]{6,}$');

-- 2. The counter.
CREATE TABLE "ReadableReferenceCounter" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReadableReferenceCounter_pkey" PRIMARY KEY ("scope")
);

-- The next number in a scope. One statement, so it is atomic: the upsert takes the row lock,
-- a concurrent caller waits for this transaction, and a rollback gives the number back.
-- Never max()+1, never random. The API calls this same function (support-reference.ts).
CREATE OR REPLACE FUNCTION "etg_next_reference_value"(p_scope TEXT) RETURNS INTEGER AS $$
  INSERT INTO "ReadableReferenceCounter" ("scope", "value", "updatedAt")
  VALUES (p_scope, 1, (now() AT TIME ZONE 'UTC'))
  ON CONFLICT ("scope") DO UPDATE
    SET "value" = "ReadableReferenceCounter"."value" + 1,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
  RETURNING "value";
$$ LANGUAGE sql VOLATILE;

-- 3. The safety net for inserts that do not name a reference (the API before this change,
-- a seed, a hand-written insert). The current API always writes one, so this does nothing for
-- it. The year is the year of "createdAt", which Prisma stores as UTC.
CREATE OR REPLACE FUNCTION "feedback_assign_reference"() RETURNS trigger AS $$
DECLARE
  yr INTEGER;
  n INTEGER;
BEGIN
  IF NEW."reference" IS NULL THEN
    yr := EXTRACT(YEAR FROM COALESCE(NEW."createdAt", (now() AT TIME ZONE 'UTC')))::int;
    n := "etg_next_reference_value"('SUP-' || yr);
    NEW."reference" := 'ETG-SUP-' || yr || '-' || lpad(n::text, GREATEST(6, length(n::text)), '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "feedback_assign_reference"
  BEFORE INSERT ON "Feedback"
  FOR EACH ROW EXECUTE FUNCTION "feedback_assign_reference"();

-- 4. Backfill. Only rows without a reference; numbered per UTC year of createdAt, oldest first
-- (id breaks ties), starting after the highest number already used in that year - whether in a
-- reference or in the counter. Running it again assigns nothing: there is no NULL row left.
-- BACKFILL BEGIN
WITH used AS (
    SELECT split_part("reference", '-', 3)::int AS yr,
           MAX(split_part("reference", '-', 4)::int) AS top
    FROM "Feedback"
    WHERE "reference" IS NOT NULL
    GROUP BY 1
),
counted AS (
    SELECT substr("scope", 5)::int AS yr, "value" AS top
    FROM "ReadableReferenceCounter"
    WHERE "scope" ~ '^SUP-[0-9]{4}$'
),
numbered AS (
    SELECT f.id,
           EXTRACT(YEAR FROM f."createdAt")::int AS yr,
           row_number() OVER (
               PARTITION BY EXTRACT(YEAR FROM f."createdAt")
               ORDER BY f."createdAt", f.id
           ) AS rn
    FROM "Feedback" f
    WHERE f."reference" IS NULL
),
assigned AS (
    SELECT n.id,
           n.yr,
           (GREATEST(COALESCE(u.top, 0), COALESCE(c.top, 0)) + n.rn)::text AS seq
    FROM numbered n
    LEFT JOIN used u ON u.yr = n.yr
    LEFT JOIN counted c ON c.yr = n.yr
)
UPDATE "Feedback" f
SET "reference" = 'ETG-SUP-' || a.yr || '-' || lpad(a.seq, GREATEST(6, length(a.seq)), '0')
FROM assigned a
WHERE f.id = a.id AND f."reference" IS NULL;

-- 5. Seed each year's counter from the highest number in use, never lowering one.
INSERT INTO "ReadableReferenceCounter" ("scope", "value", "updatedAt")
SELECT 'SUP-' || split_part("reference", '-', 3),
       MAX(split_part("reference", '-', 4)::int),
       (now() AT TIME ZONE 'UTC')
FROM "Feedback"
WHERE "reference" IS NOT NULL
GROUP BY 1
ON CONFLICT ("scope") DO UPDATE
  SET "value" = GREATEST("ReadableReferenceCounter"."value", EXCLUDED."value"),
      "updatedAt" = EXCLUDED."updatedAt";
-- BACKFILL END
