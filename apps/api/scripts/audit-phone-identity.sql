-- Phone identity audit - READ ONLY.
--
-- What it is for: before trusting "one verified mobile number = one account" on a database,
-- find every row that breaks it. Written to be run on PRODUCTION by the owner or an engineer;
-- safe there because it cannot write:
--   * the whole script runs inside BEGIN TRANSACTION READ ONLY, so Postgres itself refuses any
--     INSERT, UPDATE, DELETE or DDL;
--   * every statement is a SELECT (no temp tables, no views, no functions created);
--   * it ends in ROLLBACK.
--
-- It references ONLY columns that exist both before and after migration
-- 20261025180000_user_country_evidence, so it can be run before that migration is deployed.
--
-- Output is masked: a phone number is shown as calling code + last four digits, never in full,
-- and no email address is printed. User ids are printed so an engineer can look a row up
-- deliberately, one at a time. Do not paste the output anywhere public.
--
-- Run (a read-only database role is preferred):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/audit-phone-identity.sql
--
-- Every section prints a heading row first; nothing under a heading means "none found".
-- docs/auth/PHONE-IDENTITY.md explains each finding and its remediation path.
--
-- Normalisation here mirrors apps/api/src/auth/phone.ts `normalisePhone`: digits only, a
-- leading 00 read as +, and a domestic trunk 0 straight after a platform calling code dropped.
-- The calling codes are those in packages/shared-types/src/markets.ts, longest first.

BEGIN TRANSACTION READ ONLY;


-- 0. overview ---------------------------------------------------------------------------------
SELECT '0. overview' AS section;
SELECT
  (SELECT count(*) FROM "User")                                     AS users,
  (SELECT count(*) FROM "User" WHERE "status" = 'DELETED')          AS deleted_users,
  (SELECT count(*) FROM "User" WHERE "phone" IS NOT NULL)           AS with_phone,
  (SELECT count(*) FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL) AS phone_verified,
  (SELECT count(*) FROM "User"
    WHERE "email" LIKE 'phone+%@users.eticketsgo.internal')         AS phone_only_accounts,
  (SELECT count(*) FROM pg_indexes
    WHERE tablename = 'User' AND indexname = 'User_phone_key')      AS phone_unique_index_present;

-- 1. duplicate numbers after normalisation ----------------------------------------------------
-- The unique index compares stored strings, so "+919876543210" and "+91 09876543210" could both
-- exist. Each group_no is ONE number held by several accounts. Never merge automatically.
SELECT '1. duplicate numbers after normalisation' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT dense_rank() OVER (ORDER BY normalised) AS group_no, masked, "id" AS user_id, "status",
       ("phoneVerifiedAt" IS NOT NULL) AS verified
FROM (SELECT phones.*, count(*) OVER (PARTITION BY normalised) AS holders FROM phones) p
WHERE holders > 1
ORDER BY normalised, "id";

-- 2. stored numbers not in canonical E.164 ----------------------------------------------------
-- Not "+" then 8-15 digits with no leading 0, or not equal to their own normalised form
-- (spaces, dashes, a 00 prefix, a trunk 0 kept after the calling code).
SELECT '2. stored numbers not in canonical E.164' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT masked, "id" AS user_id, "status",
       ("phone" !~ '^\+[1-9][0-9]{7,14}$') AS bad_shape,
       ("phone" <> normalised)            AS differs_from_normalised
FROM phones
WHERE "phone" !~ '^\+[1-9][0-9]{7,14}$' OR "phone" <> normalised
ORDER BY "id";

-- 3. numbers whose calling code is not a platform market --------------------------------------
SELECT '3. numbers whose calling code is not a platform market' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT masked, "id" AS user_id, "status" FROM phones WHERE calling_code IS NULL ORDER BY "id";

-- 4a. phone present but never verified --------------------------------------------------------
-- The API writes `phone` only together with `phoneVerifiedAt`. Either half alone came from
-- somewhere else (a seed, a hand edit) and must not be trusted for sign-in.
SELECT '4a. phone present but never verified' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT masked, "id" AS user_id, "status" FROM phones WHERE "phoneVerifiedAt" IS NULL ORDER BY "id";

-- 4b. verified timestamp but no phone ---------------------------------------------------------
SELECT '4b. verified timestamp but no phone' AS section;
SELECT "id" AS user_id, "status" FROM "User"
WHERE "phone" IS NULL AND "phoneVerifiedAt" IS NOT NULL ORDER BY "id";

-- 5. phone-only placeholder address that no longer matches the number -------------------------
-- A phone-only account's email is phone+<digits>@users.eticketsgo.internal. If its number was
-- cleared or changed while the placeholder stayed, a NEW sign-up with the original number
-- collides on the placeholder and is refused ("This number cannot be used to sign in right
-- now"). Account deletion through the API replaces the email too, so a DELETED row listed
-- here was changed some other way (seed, hand edit).
SELECT '5. phone-only placeholder address that no longer matches the number' AS section;
SELECT u."id" AS user_id, u."status", (u."phone" IS NULL) AS phone_cleared,
       '...' || right(split_part(split_part(u."email", '@', 1), '+', 2), 4) AS placeholder_last4
FROM "User" u
WHERE u."email" LIKE 'phone+%@users.eticketsgo.internal'
  AND (u."phone" IS NULL
       OR split_part(split_part(u."email", '@', 1), '+', 2)
          <> regexp_replace(u."phone", '\D', '', 'g'))
ORDER BY u."id";

-- 6. deleted accounts still holding a number --------------------------------------------------
-- Account deletion clears phone and phoneVerifiedAt. A deleted row that still holds one blocks
-- that number from ever signing up again.
SELECT '6. deleted accounts still holding a number' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT masked, "id" AS user_id FROM phones WHERE "status" = 'DELETED' ORDER BY "id";

-- 7. number declared on one account, verified on another (informational) ----------------------
-- Probably one person with two accounts: an email account that declared a number at sign-up
-- (SMS consent evidence) while a DIFFERENT account holds that number verified. Typical cause:
-- email sign-up first, phone sign-up later. Informational only - never merge automatically.
SELECT '7. number declared on one account, verified on another (informational)' AS section;
WITH codes(code) AS (VALUES ('971'), ('91'), ('65'), ('64'), ('61'), ('44'), ('1')),
raw AS (
  SELECT u."id", u."phone", u."phoneVerifiedAt", u."status",
         regexp_replace(u."phone", '\D', '', 'g') AS d0
  FROM "User" u WHERE u."phone" IS NOT NULL
),
d AS (SELECT raw.*, CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d1 FROM raw),
phones AS (
  SELECT d.*,
    '+' || COALESCE(
      (SELECT c.code || substr(d.d1, length(c.code) + 2) FROM codes c
        WHERE d.d1 LIKE c.code || '0%' ORDER BY length(c.code) DESC LIMIT 1),
      d.d1) AS normalised,
    (SELECT c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1) AS calling_code,
    COALESCE((SELECT '+' || c.code FROM codes c WHERE d.d1 LIKE c.code || '%'
      ORDER BY length(c.code) DESC LIMIT 1), '+?') || ' ...' || right(d.d1, 4) AS masked
  FROM d
)
SELECT DISTINCT p.masked, mc."userId" AS declared_on_user_id, p."id" AS verified_on_user_id
FROM "MarketingConsent" mc
JOIN phones p ON p.normalised = mc."phone" AND p."id" <> mc."userId"
WHERE mc."phone" IS NOT NULL AND mc."userId" IS NOT NULL AND p."phoneVerifiedAt" IS NOT NULL
ORDER BY 1, 2;

-- 8. sign-in code rows stored against a non-canonical number (count only) ---------------------
SELECT '8. sign-in code rows stored against a non-canonical number (count only)' AS section;
SELECT count(*) AS otp_rows_not_e164 FROM "PhoneOtp" WHERE "phone" !~ '^\+[1-9][0-9]{7,14}$';

ROLLBACK;
