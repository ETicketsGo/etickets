-- Authoritative IANA timezone on Cinema.
--
-- Backward compatible by construction:
--   * The column is NOT NULL WITH A DEFAULT, so every existing row is backfilled in place
--     without a table rewrite and without a separate data migration.
--   * Because the default exists, an older API instance that does not yet know about the
--     column keeps inserting cinemas successfully during a rolling deploy.
--
-- The default is 'Asia/Kolkata' because every cinema that exists today is in India. It is a
-- BACKFILL VALUE, not a runtime fallback — application code reads the column and never
-- substitutes a literal. See the schema comment on Cinema.timezone.
ALTER TABLE "Cinema"
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- Belt and braces: if a prior partial deploy added the column as nullable, fill and tighten
-- it. Cheap, and makes the migration safe to run against a half-migrated database.
UPDATE "Cinema" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" IS NULL;
ALTER TABLE "Cinema" ALTER COLUMN "timezone" SET NOT NULL;
