-- Country evidence on an account, each fact kept apart and labelled by where it came from.
--
-- The problem (production admin Accounts page, 2026-10-25): 7 of 8 accounts read "Country not
-- known", because the only country an account had was DERIVED from its bookings and organizer
-- memberships. Nothing recorded what the platform did know at sign-up.
--
-- Additive and backward compatible:
--   * three NULLABLE columns, no default, no constraint - the API currently deployed inserts
--     and updates users without naming them and keeps working unchanged;
--   * no backfill: residence is only ever what a person chose (nobody has yet), and a detected
--     country can only be captured at the moment of sign-up. The phone calling code is NOT a
--     column - it is read from the verified `User.phone` (already E.164 and unique), so it can
--     never drift from the number and needs no backfill;
--   * no existing column, index or row changes. `User_phone_key` (unique, since the initial
--     migration) already makes one verified number one account.

ALTER TABLE "User" ADD COLUMN "countryOfResidence" TEXT;
ALTER TABLE "User" ADD COLUMN "detectedCountry" TEXT;
ALTER TABLE "User" ADD COLUMN "detectedCountrySource" TEXT;
