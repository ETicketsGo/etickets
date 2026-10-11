-- Payout per-event scoping: impact check for PRODUCTION.
--
-- DO NOT RUN without the owner's explicit authorization for the production environment.
-- Background: docs/finance/PAYOUT-SCOPING-INVESTIGATION.md (#320). The fix is #322.
-- Already run read-only on QA and UAT on 2026-10-11: every query returned 0 rows, and no
-- Settlement had ever reached a claimed status.
--
-- Safety properties:
--   * READ ONLY transaction, rolled back at the end - nothing can be written.
--   * statement_timeout bounds every query (30s); LIMIT 200 bounds every result.
--   * Output is ids, counts, amounts in minor units and statuses only - no names, emails,
--     phone numbers, bank details or payment references.
--
-- Run with: psql ... -v ON_ERROR_STOP=1 -f payout-impact-queries-production.sql

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 0. Context: is the bug even reachable here? It needs an event-scoped payout raised after a
--    provider Settlement claimed that event. If there are no claimed settlements, stop here.
SELECT status, count(*) AS settlements
  FROM "Settlement"
 GROUP BY status
 ORDER BY status;

SELECT count(*) AS payouts,
       count(*) FILTER (WHERE "eventId" IS NOT NULL) AS event_scoped_payouts
  FROM "Payout";

-- 1. Event-scoped payouts whose allocations include another event's bookings (definitive harm).
SELECT p.id AS payout_id, p."organizationId", p."eventId" AS labelled_event, p.status,
       p.currency, p."netMinor",
       count(*) FILTER (WHERE a."eventId" <> p."eventId")                   AS foreign_allocations,
       sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" <> p."eventId") AS foreign_net_minor
  FROM "Payout" p
  JOIN "PayoutAllocation" a ON a."payoutId" = p.id
 WHERE p."eventId" IS NOT NULL
 GROUP BY p.id
HAVING bool_or(a."eventId" <> p."eventId")
 ORDER BY p."createdAt"
 LIMIT 200;

-- 2. A booking's revenue allocated in two or more standing payouts (the double-pay).
SELECT a."bookingId", a."eventId", count(DISTINCT a."payoutId") AS payouts,
       array_agg(DISTINCT a."payoutId") AS payout_ids, sum(a."allocatedNetMinor") AS net_minor
  FROM "PayoutAllocation" a
  JOIN "Payout" p ON p.id = a."payoutId"
 WHERE a."subtotalMinor" > 0 AND p.status IN ('PENDING', 'SCHEDULED', 'PAID')
 GROUP BY a."bookingId", a."eventId"
HAVING count(DISTINCT a."payoutId") > 1
 LIMIT 200;

-- 3. Payouts without allocations (older than the allocation ledger) that were event-scoped and
--    raised after a provider settlement claimed that event: suspects needing a manual check.
SELECT p.id AS payout_id, p."organizationId", p."eventId", p.status, p.currency, p."netMinor",
       p."allocatedFrom", s.id AS settlement_id, s.status AS settlement_status,
       s."createdAt" AS settlement_created
  FROM "Payout" p
  JOIN "Settlement" s
    ON s."eventId" = p."eventId" AND s."organizationId" = p."organizationId"
   AND s.status IN ('TRANSFER_PROCESSING', 'TRANSFERRED', 'PARTIALLY_REFUNDED', 'REVERSED')
 WHERE p."eventId" IS NOT NULL
   AND p.status IN ('PENDING', 'SCHEDULED', 'PAID')
   AND s."createdAt" <= p."createdAt"
 ORDER BY p."createdAt"
 LIMIT 200;

-- 4. Event-scoped payouts whose recorded net differs from their own event's allocations.
SELECT p.id AS payout_id, p.currency, p."netMinor" AS recorded_net,
       coalesce(sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" = p."eventId"), 0) AS own_event_net
  FROM "Payout" p
  LEFT JOIN "PayoutAllocation" a ON a."payoutId" = p.id
 WHERE p."eventId" IS NOT NULL AND p."allocatedFrom" IS NOT NULL
 GROUP BY p.id, p.currency, p."netMinor"
HAVING p."netMinor" <> coalesce(sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" = p."eventId"), 0)
 LIMIT 200;

ROLLBACK;
