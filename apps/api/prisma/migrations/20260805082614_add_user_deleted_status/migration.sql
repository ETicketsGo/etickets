-- Self-service account deletion.
--
-- The user row is NOT removed. Bookings, tickets, check-ins, settlements and audit
-- entries reference it and are retained for tax, dispute and fraud purposes; deleting
-- the row would either break those foreign keys or silently orphan financial history.
-- Instead the account moves to DELETED and its personal data is anonymised in place.
--
-- Adding a value to an existing enum is additive and safe: no existing row changes, and
-- older application code that does not know the value still reads every row it did before.
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'DELETED';
