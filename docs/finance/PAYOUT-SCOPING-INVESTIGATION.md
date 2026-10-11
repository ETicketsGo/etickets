# Payout per-event scoping: investigation

Status: investigation only. Payout logic is frozen; nothing in this PR changes behaviour.
Base: origin/main 6d9b4d1. Reported by #313.

## Verdict

The overwrite is REAL and REACHABLE, in three queries in `apps/api/src/payouts/payouts.service.ts`
(`payableBookingWhere`, the refund query in `settle`, and `heldRevenue`). It only bites in one
situation: **an event-scoped request (`eventId` given) for an event that a provider settlement
already claims.** Organization scoping is NOT affected (see "Organization isolation").

A failing reproduction is in the fix PR (it passes on correct code and fails on main).

## How the overwrite happens

Each of the three queries builds one object literal with two spread keys:

    ...(eventId ? { eventId } : {}),
    ...(transferredEventIds.length > 0 ? { eventId: { notIn: transferredEventIds } } : {}),

Both write the key `eventId`. When both spreads fire, the second replaces the first.
`settlementScope` reads the claimed settlements with `...(eventId ? { eventId } : {})`, so for an
event-scoped request `transferredEventIds` is empty or exactly `[eventId]`. When it is
`[eventId]` the filter becomes `eventId NOT IN (eventId)`: **every event of the organization
except the one asked for.** For an org-wide request the first spread does not fire, so nothing is
lost there.

## Full flow (names are in `payouts.service.ts` unless stated)

Callers that pass an `eventId`:

| Caller                                                                                                                | Passes eventId?                                            |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /payouts/generate` -> `PayoutsController.generate` -> `PayoutsService.generate(user, org, eventId?)` -> `raise` | yes, optional (organizer owner/manager, `payout.generate`) |
| `GET /payouts/summary` -> `PayoutsService.summary(user, org, eventId?)`                                               | yes, optional                                              |
| `PayoutRunService` -> `generateAutomatically(org, scheduledFor)` -> `raise(org, undefined, ...)`                      | never (settlement runs are org-wide)                       |
| `GET /payouts/finance` -> Unified Finance `forOrganization(user, org, eventId?)`                                      | reads allocations and settlements; does not call `settle`  |
| admin list / `markPaid` / `markFailed`                                                                                | no event scope                                             |

`raise(org, eventId?, run)`:

1. `pg_advisory_xact_lock(payout-generate:<org>)` serialises generates per organization.
2. `settlementScope(tx, org, eventId)` (read only):
   - `standing`: payouts of the org in PENDING/SCHEDULED/PAID, narrowed to `eventId` or org-wide
     payouts when an event is given.
   - `settledUntil` (per currency cursor) and `eventSettled` (per event cursors; only filled for
     an org-wide request).
   - `transferredEventIds`: `Settlement` rows of the org in `SETTLEMENT_CLAIMED_STATUSES`
     (TRANSFER_PROCESSING, TRANSFERRED, PARTIALLY_REFUNDED, REVERSED), narrowed to `eventId`.
   - `terms` from `PayoutSettingsService.effectiveFor` (hold days, minimums).
3. `settle(...)` runs two queries:
   - `booking.findMany(payableBookingWhere(...))`: organizationId, ONLINE, event filter
     (`payableEventFilter`: COMPLETED/ARCHIVED and no session ending after now - holdDays),
     eventId scope, claimed-event exclusion, per-currency confirmation windows, per-event
     cursors.
   - `refund.findMany`: COMPLETED refunds of the org, on the same booking population, in the
     refund window (`updatedAt`).
   - `calculateCurrencySettlement` (gross, discount, fees, organizer fee, refund, net) and
     `allocateCurrencySettlement` (one `PayoutAllocation` per booking, pure clawbacks for refunds
     whose booking is outside the revenue window) both receive the same rows.
4. If nothing settles, `heldRevenue` (`booking.groupBy` event x currency) explains why
   ("held until each event has finished"). `summary` also uses it for the `held` figure.
5. Minimum check, duplicate-open-payout guard, then the gate `allocatedNet == payout net`
   (exact integer equality, else the transaction rolls back).
6. `payout.create` (with `eventId` set to the REQUESTED event) and `payoutAllocation.createMany`
   in the same transaction; audit record after commit.
7. Downstream: `eventMembership` (`payout-membership.ts`) and the Unified Finance composer read
   allocations by `eventId`; payout reconciliation reads `Payout`/`PayoutAllocation`.

## What goes wrong (reachable path)

Precondition: org O has events X (claimed by a provider Settlement in a claimed status) and Y, Z
(finished, payable).

`POST /payouts/generate {organizationId: O, eventId: X}`:

- `transferredEventIds = [X]`; the `eventId` filter becomes `NOT IN (X)`.
- `payableBookingWhere` selects the bookings of Y and Z (all of O's other payable events), the
  refund query selects refunds on Y and Z, and `heldRevenue` lists O's other unfinished events.
- The allocation gate passes (totals and allocations come from the same wrong rows), so a payout
  is written with `eventId = X`, whose allocations belong to Y and Z.
- Standing payouts keyed `eventId = X` do not cover Y or Z in later cursors (`standing` for a Y
  scope is `eventId = Y OR null`; org-wide cursors only count X's own end for X), so Y and Z are
  paid AGAIN by their next payout. Measured in the reproduction: allocations for the second event
  sum to 12000 where 6000 is owed.

Expected correct behaviour: nothing to settle, CONFLICT "no new paid revenue" (the money belongs
to the provider path).

`GET /payouts/summary?eventId=X` (read only) shows the same wrong net and held figures, so an
organizer is shown other events' money under X's name.

`generate` and `summary` without an `eventId`, and settlement runs, are unaffected.

## Organization isolation

`organizationId` is a separate key in every one of the three queries (and is the first key of
`standing` and `transferred`), so no query can return another organization's bookings or
refunds. Proven in `payout-scoping.integration-postgres.spec.ts` (passes on main).

## Impact on existing records

A payout can be wrong only if ALL hold: it was created by a manual `generate` with an `eventId`;
and a provider Settlement for that event was in a claimed status at that moment. Provider
settlements exist only where the Stripe Connect / Razorpay Route transfer path ran (QA and UAT
rehearsals; production transfer execution is held off by the owner's release gate). Settlement
runs never pass an eventId, so scheduled payouts are not affected. Whether any such record exists
is unknown until an operator runs the queries below.

Affected rows carry `Payout.eventId = X` and allocations whose `eventId` is not X, and/or a later
payout that re-pays those bookings.

### Read-only SQL (for an operator to run; not executed by this work)

```sql
-- 1. Event-scoped payouts whose allocations include another event's bookings (definitive).
SELECT p.id, p."organizationId", p."eventId" AS labelled_event, p.status, p."netMinor",
       count(*) FILTER (WHERE a."eventId" <> p."eventId")                   AS foreign_allocations,
       sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" <> p."eventId") AS foreign_net_minor
  FROM "Payout" p
  JOIN "PayoutAllocation" a ON a."payoutId" = p.id
 WHERE p."eventId" IS NOT NULL
 GROUP BY p.id
HAVING bool_or(a."eventId" <> p."eventId")
 ORDER BY p."createdAt";

-- 2. Revenue allocated more than once: a booking's revenue (subtotal > 0) in two payouts that
--    both stand (FAILED payouts return their revenue, so they are excluded).
SELECT a."bookingId", a."eventId", count(DISTINCT a."payoutId") AS payouts,
       array_agg(DISTINCT a."payoutId") AS payout_ids, sum(a."allocatedNetMinor") AS net_minor
  FROM "PayoutAllocation" a
  JOIN "Payout" p ON p.id = a."payoutId"
 WHERE a."subtotalMinor" > 0 AND p.status IN ('PENDING', 'SCHEDULED', 'PAID')
 GROUP BY a."bookingId", a."eventId"
HAVING count(DISTINCT a."payoutId") > 1;

-- 3. Payouts that predate allocations (allocatedFrom IS NULL) cannot be checked by 1 or 2.
--    Flag any event-scoped payout raised after a provider settlement already claimed that
--    event; each needs a manual comparison of its totals with the correctly scoped sum.
SELECT p.id, p."organizationId", p."eventId", p.status, p."netMinor", p."allocatedFrom",
       s.id AS settlement_id, s.status AS settlement_status, s."createdAt" AS settlement_created
  FROM "Payout" p
  JOIN "Settlement" s
    ON s."eventId" = p."eventId" AND s."organizationId" = p."organizationId"
   AND s.status IN ('TRANSFER_PROCESSING', 'TRANSFERRED', 'PARTIALLY_REFUNDED', 'REVERSED')
 WHERE p."eventId" IS NOT NULL
   AND p.status IN ('PENDING', 'SCHEDULED', 'PAID')
   AND s."createdAt" <= p."createdAt";

-- 4. Totals that differ from the labelled event's own allocations (payouts with allocations).
SELECT p.id, p."netMinor" AS recorded_net,
       coalesce(sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" = p."eventId"), 0) AS own_event_net
  FROM "Payout" p LEFT JOIN "PayoutAllocation" a ON a."payoutId" = p.id
 WHERE p."eventId" IS NOT NULL AND p."allocatedFrom" IS NOT NULL
 GROUP BY p.id, p."netMinor"
HAVING p."netMinor" <> coalesce(sum(a."allocatedNetMinor") FILTER (WHERE a."eventId" = p."eventId"), 0);
```

Query 3 can match a payout that is correct (the claim may have come after an earlier correct
payout); queries 1, 2 and 4 are the ones that prove harm.

## Tests in this PR

`payout-scoping.integration-postgres.spec.ts` (passes on main): two organizations, two finished
events each plus one held event; event-scoped summary and payout, held scope, cross-organization
isolation, and conservation per event and organization before and after a refund of
already-paid revenue. Shared fixtures are in `payout-scoping.fixture.ts`.

## Proposed correction (separate PR, not for merge without owner approval)

One helper, `eventIdFilter(eventId, transferredEventIds)`, builds the single `eventId` condition
(`{ equals: eventId, notIn: transferred }` when both apply) and is used by all three queries, so
the two rules can no longer overwrite each other. The failing reproduction is in that PR. No other
payout behaviour changes.
