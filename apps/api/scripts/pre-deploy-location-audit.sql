-- ETicketsGo - READ-ONLY pre-deployment audit: Cinema/Venue ownership and location.
--
-- WHAT THIS IS FOR
-- Run against an environment BEFORE deploying the venue/space migrations
--   20261007090000_space_belongs_to_venue        (aborts on cross-tenant history)
--   20261007110000_venue_location_is_answerable  (drops the India defaults)
-- and before any later migration that drops Cinema's legacy location columns.
--
-- It is written for the PRE-migration schema that QA, UAT and production run today (they are
-- on commits from before PR #240). The Prisma-based `audit-space-location.mjs` cannot be used
-- there: it queries `Screen."venueId"`, which does not exist until the migration has run.
--
-- SAFETY
--   - READ ONLY transaction: the server refuses any write inside it.
--   - Short statement and lock timeouts, so it cannot hold up the live service.
--   - Ends in ROLLBACK. Nothing is created, changed or deleted.
--   - Prints ids and place names only. No customer data, no credentials, no money.
--
-- HOW TO RUN (an authorised operator, never pasted into chat or logs with credentials):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/pre-deploy-location-audit.sql
-- Full procedure and how to read the result: docs/product/QA-PRE-DEPLOY-LOCATION-AUDIT.md
--
-- OUTPUT: one table, columns (section, verdict, entity_id, detail).
--   verdict BLOCKS_DEPLOY   the migration WILL abort; a human must decide the repair first.
--   verdict NEEDS_DECISION  the migration will run, but the result needs a human look.
--   verdict INFO            context; nothing to decide.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- AUDIT-QUERY-BEGIN
SELECT section, verdict, entity_id, detail
FROM (
  -- 0. Which schema is this? A pre-deploy audit run against an already-migrated database is
  --    answering a different question, so say so before anything else.
  SELECT '0 FINGERPRINT' AS section, 'INFO' AS verdict, NULL::text AS entity_id,
         'latest applied migration: ' || COALESCE(
           (SELECT migration_name FROM "_prisma_migrations"
             WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1), 'none')
         AS detail, 0 AS ord
  UNION ALL
  SELECT '0 FINGERPRINT', 'INFO', NULL,
         'space_belongs_to_venue applied: ' || CASE WHEN EXISTS (
           SELECT 1 FROM "_prisma_migrations"
            WHERE migration_name = '20261007090000_space_belongs_to_venue'
              AND finished_at IS NOT NULL) THEN 'YES - this audit is for the pre-migration state'
           ELSE 'no (expected before deploy)' END, 0
  UNION ALL
  SELECT '0 FINGERPRINT', 'INFO', NULL,
         'Screen.venueId column present: ' || CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'Screen'
              AND column_name = 'venueId') THEN 'yes' ELSE 'no (expected before deploy)' END, 0

  UNION ALL
  -- A. Cross-tenant history. EXACTLY the predicate migration 090000 aborts on: a cinema owned
  --    by one organization pointing at a venue owned by another. Any row here means the deploy
  --    will stop, by design, and a human must decide which side is right before it can run.
  SELECT 'A CROSS_TENANT', 'BLOCKS_DEPLOY', c."id",
         'cinema "' || c."name" || '" (org ' || c."organizationId" || ') -> venue "'
           || v."name" || '" ' || v."id" || ' (org ' || v."organizationId" || ')', 1
    FROM "Cinema" c
    JOIN "Venue" v ON v."id" = c."venueId"
   WHERE c."organizationId" <> v."organizationId"

  UNION ALL
  -- B. Cinemas with screens and no venue. The migration creates one venue for each, copied
  --    from the cinema's own columns. Without a country that venue cannot price anything:
  --    checkout fails closed until somebody says where it is.
  SELECT 'B CINEMA_WITHOUT_VENUE',
         CASE WHEN c."country" IS NULL OR btrim(c."country") = '' THEN 'NEEDS_DECISION' ELSE 'INFO' END,
         c."id",
         'cinema "' || c."name" || '" in ' || c."city" || ' will get a new venue; country='
           || COALESCE(NULLIF(btrim(c."country"), ''), 'UNKNOWN (sales will fail closed)')
           || ', timezone=' || COALESCE(c."timezone", 'UNKNOWN')
           || ', screens=' || (SELECT COUNT(*) FROM "Screen" s WHERE s."cinemaId" = c."id"), 2
    FROM "Cinema" c
   WHERE c."venueId" IS NULL
     AND EXISTS (SELECT 1 FROM "Screen" s WHERE s."cinemaId" = c."id")

  UNION ALL
  -- C. Same-tenant cinemas that disagree with their venue about where they are. Only a real
  --    disagreement counts - a NULL on either side is an absence, not a conflict. These decide
  --    what is lost when Cinema's location columns are eventually dropped.
  SELECT 'C LOCATION_CONFLICT', 'NEEDS_DECISION', c."id",
         'cinema "' || c."name" || '" vs venue "' || v."name" || '": '
           || concat_ws('; ',
                CASE WHEN c."city" IS NOT NULL AND v."city" IS NOT NULL AND c."city" <> v."city"
                     THEN 'city ' || c."city" || ' / ' || v."city" END,
                CASE WHEN c."country" IS NOT NULL AND v."country" IS NOT NULL AND c."country" <> v."country"
                     THEN 'country ' || c."country" || ' / ' || v."country" END,
                CASE WHEN c."region" IS NOT NULL AND v."region" IS NOT NULL AND c."region" <> v."region"
                     THEN 'region ' || c."region" || ' / ' || v."region" END,
                CASE WHEN c."timezone" IS NOT NULL AND v."timezone" IS NOT NULL AND c."timezone" <> v."timezone"
                     THEN 'timezone ' || c."timezone" || ' / ' || v."timezone" END,
                CASE WHEN c."address" IS NOT NULL AND v."address" IS NOT NULL AND c."address" <> v."address"
                     THEN 'address differs' END), 3
    FROM "Cinema" c
    JOIN "Venue" v ON v."id" = c."venueId" AND v."organizationId" = c."organizationId"
   WHERE (c."city" IS NOT NULL AND v."city" IS NOT NULL AND c."city" <> v."city")
      OR (c."country" IS NOT NULL AND v."country" IS NOT NULL AND c."country" <> v."country")
      OR (c."region" IS NOT NULL AND v."region" IS NOT NULL AND c."region" <> v."region")
      OR (c."timezone" IS NOT NULL AND v."timezone" IS NOT NULL AND c."timezone" <> v."timezone")
      OR (c."address" IS NOT NULL AND v."address" IS NOT NULL AND c."address" <> v."address")

  UNION ALL
  -- D. Venues that may be holding a DEFAULT rather than an answer. Before 110000 a venue
  --    nobody asked still said India / Asia/Kolkata. Where its own cinema - whose zone and
  --    country are written from what the operator chose - says otherwise, the venue's value is
  --    probably the default. This is the Sydney shape that once stored a 00:30 show as 06:00.
  SELECT DISTINCT 'D SUSPECT_DEFAULT', 'NEEDS_DECISION', v."id",
         'venue "' || v."name" || '" says ' || v."country" || ' / ' || v."timezone"
           || '; its cinema "' || c."name" || '" says '
           || COALESCE(c."country", '?') || ' / ' || COALESCE(c."timezone", '?'), 4
    FROM "Venue" v
    JOIN "Cinema" c ON c."venueId" = v."id" AND c."organizationId" = v."organizationId"
   WHERE (v."timezone" = 'Asia/Kolkata' AND c."timezone" IS NOT NULL AND c."timezone" <> 'Asia/Kolkata')
      OR (v."country" = 'India' AND c."country" IS NOT NULL
          AND lower(btrim(c."country")) NOT IN ('india', 'in', 'ind'))

  UNION ALL
  -- E. VenueArea - the vestigial standing-area model. Expected to be empty or seed-only; rows
  --    here would have to be considered before that table is ever removed.
  SELECT 'E VENUE_AREA', CASE WHEN COUNT(*) = 0 THEN 'INFO' ELSE 'NEEDS_DECISION' END, NULL,
         COUNT(*) || ' VenueArea row(s)', 5
    FROM "VenueArea"

  UNION ALL
  -- F. Size of what the migration touches.
  SELECT 'F SUMMARY', 'INFO', NULL,
         (SELECT COUNT(*) FROM "Venue") || ' venues, '
           || (SELECT COUNT(*) FROM "Cinema") || ' cinemas, '
           || (SELECT COUNT(*) FROM "Screen") || ' screens', 6
) audit
ORDER BY ord, section, entity_id NULLS FIRST, detail;
-- AUDIT-QUERY-END

ROLLBACK;
