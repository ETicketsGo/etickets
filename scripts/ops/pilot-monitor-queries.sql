-- Pilot monitoring queries (docs/pilot/INFRASTRUCTURE.md section 6). READ-ONLY.
-- Run with psql against the environment's database from inside its private network (or a
-- temporary approved proxy). Each query should return ZERO rows on a healthy platform.

-- 1. Captured but unconfirmed: money taken, booking not confirmed, older than 10 minutes.
--    The P0 class: a paid booking released as an abandoned cart.
SELECT p.id AS payment_id, p."bookingId", p.provider, p.status AS payment_status,
       b.status AS booking_status, p."amountMinor", p.currency, p."updatedAt"
FROM "Payment" p JOIN "Booking" b ON b.id = p."bookingId"
WHERE p.status = 'SUCCEEDED'
  AND b.status IN ('PENDING_PAYMENT', 'EXPIRED', 'CANCELLED')
  AND p."updatedAt" < now() - interval '10 minutes';

-- 2. Payouts waiting more than 3 days (held pending bank verification, or stuck).
SELECT po.id AS payout_id, po."organizationId", po.status, po."netMinor", po.currency,
       po."scheduledAt", po."createdAt"
FROM "Payout" po
WHERE po.status IN ('PENDING', 'SCHEDULED')
  AND po."createdAt" < now() - interval '3 days';

-- 3. Organizer payout accounts saved but still unverified after 2 days (the maker-checker queue
--    needs a SECOND authorised staff member; this is where it stalls).
SELECT a.id AS account_id, a."organizationId", a.currency, a."createdAt"
FROM "OrganizerPayoutAccount" a
WHERE a."verifiedAt" IS NULL
  AND a."createdAt" < now() - interval '2 days';

-- 4. Newest verified backup (should be under 26 hours old). Empty result = none ever recorded.
SELECT "entityId" AS dump, "createdAt", now() - "createdAt" AS age
FROM "AuditLog"
WHERE action = 'BACKUP_VERIFIED' AND "entityType" = 'DatabaseBackup'
ORDER BY "createdAt" DESC LIMIT 1;
