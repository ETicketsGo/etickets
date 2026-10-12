# FIN-1: organizer totals after refunds

Status: NEEDS OWNER APPROVAL. The finance subsystem is frozen; this change touches READ MODELS only.
Base: main 3ef1b51. Branch: `fix/fin1-organizer-totals-after-refunds`.
Origin: QA certification 2026-10-12, `docs/pilot/CERTIFICATION-EVIDENCE.md` finding 2.

## Symptom

Pilot org `cmv4shqau0072lecwmkgsjn0g`, event `cmv4shquo007zlecwp0fyjh4q`. Two of three bookings were
refunded (refunds COMPLETED). Then:

| Surface                               | Showed                                      | Should show                                                          |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `GET /payouts/summary` `held`         | 299,600                                     | 99,800                                                               |
| `GET /payouts/finance` `pendingMinor` | 299,600                                     | 299,600 - 191,809 = 107,791 (or the payout's 99,800 once one exists) |
| Admin settlement row                  | `refundsMinor` 191,809, `payableMinor` 0    | (already right)                                                      |
| Generated payout                      | gross 299,600 - refund 199,800 = net 99,800 | (already right)                                                      |

## Reproduction

`apps/api/src/payouts/fin1-organizer-totals-after-refunds.integration-postgres.spec.ts` (real
Postgres, unique fixtures, cleaned up). It builds the QA shape: an organization with NO linked
payment account, bookings of 149,900 / 49,900 / 99,800, the first two refunded in full, and a
Razorpay settlement row with `accountId` null as the payment webhook leaves it.
Before the fix 6 of its 8 tests fail with the wrong numbers above (held 299,600; pending 299,600;
and, once a payout exists, pending 399,400 = 99,800 + 299,600).

## Trace

1. Payment success calls `SettlementService.onPaymentSucceeded` -> `syncForEvent`
   (`payments/settlement/settlement.service.ts:75`). It upserts a `Settlement` for EVERY event with a
   captured payment, whether or not the organizer has a linked account (`accountId`/`connectedAccountId`
   become null). `grossSalesMinor` is the sum of `Payment.organizerNetMinor` and deliberately INCLUDES
   since-refunded payments (comment at line 83).
2. The refund webhook calls `applyRefund` (`settlement.service.ts:815`), the ONLY writer of
   `Settlement.refundsMinor`, adding the organizer's share. This is why the row reads 191,809.
3. The platform ledger is separate. `PayoutsService.generate` reads bookings and COMPLETED refunds
   directly (`payouts.service.ts` `settle`) and only skips events a settlement has CLAIMED
   (`SETTLEMENT_CLAIMED_STATUSES`: TRANSFER_PROCESSING, TRANSFERRED, PARTIALLY_REFUNDED, REVERSED). A
   settlement in HELD/ELIGIBLE has claimed nothing, so the same revenue legitimately gets a payout.
4. `SettlementService.release` cannot move that settlement: it refuses while a PENDING/SCHEDULED/PAID
   payout covers the event (`settlement.service.ts` "claimedByLedger"), and for Razorpay it BLOCKS
   when Route is off or there is no `connectedAccountId`.

## Exact cause (two read rules)

1. `PayoutsService.heldRevenue` (`apps/api/src/payouts/payouts.service.ts`, the `booking.groupBy` that
   summed `subtotalMinor`; line ~596 at 3ef1b51). It had no refund netting, although the payout that
   finally settles the same bookings does deduct COMPLETED refunds. A fully refunded booking stayed
   in `held` until the event became payable. This feeds `summary().currencies[].held` and
   `heldRevenue[].grossMinor`.
2. Unified Finance counted a provider settlement's entitlement as `grossSalesMinor` at every stage:
   - `provider-finance.producer.ts` `money.organizerNetMinor = settlement.grossSalesMinor`
     (line ~235 at 3ef1b51), and hid `refundsMinor` before release on the premise that "only
     release() computes it". That premise is false: `release()` only READS it; `applyRefund` writes it
     on every refund webhook.
   - `unified-finance.composer.ts` `buildSummary` summed every entry, so an unmoved settlement and a
     platform payout for the same event were both added (the existing `DOUBLE_CLAIM` warning fired
     but did not change the totals).

## Does anything count twice where money can MOVE? No. Read model only.

Evidence, per writer:

- `generate` / `raise`: excludes events whose settlement is in a claimed status; reads bookings and
  refunds itself. It never reads `heldRevenue`, `buildSummary`, or `Settlement.grossSalesMinor`.
  `payout-event-scope-claimed.integration-postgres.spec.ts` and `payout-scoping` specs cover it.
- `markPaid`: operates on a Payout row; unchanged.
- `SettlementService.release`: refuses when a standing payout covers the event; blocks without a
  linked account; computes `payable = gross - refunds - disputes - prior - reserve` itself
  (`computeSettlementPayable`) and never uses a read model.
- Settlement runs, allocation and transfer writers: untouched by this change, and none reads
  `UnifiedFinanceService` or `PayoutsService.summary` (grep: those are consumed only by controllers).
- The new spec snapshots settlements, payouts and refunds before and after calling both read
  endpoints and requires them identical.

So the defect overstated what the organizer was SHOWN. No code path pays, transfers or allocates
from the overstated figures.

## Fix

Smallest correction, three read-side edits, no schema or API-shape removal:

1. `heldRevenue`: reads the COMPLETED refunds against the same booking population and nets them with
   the payout's own arithmetic (`amountMinor - taxAddedMinor`). `grossMinor` now means "held after
   refunds"; a new additive `refundedMinor` shows what was netted, so held + refunded reconciles to
   sold. A fully refunded event drops out of `heldRevenue`. No UI change is needed because the
   finance page already renders `grossMinor`.
2. `providerFinanceEntry`: while nothing has been transferred (statuses outside
   TRANSFER_PROCESSING/TRANSFERRED/PARTIALLY_REFUNDED/REVERSED) the entitlement is
   `max(0, grossSalesMinor - refundsMinor)` and a positive `refundsMinor` is reported. After money has
   moved the entitlement is the gross again and refunds stay a clawback in `movement` (unchanged, and
   pinned by the existing "is never the amount still held" test).
3. `composeFinance`: a provider settlement in PENDING/HELD/ELIGIBLE/APPROVED with no movement whose
   event is authoritatively covered by a live (not FAILED) platform entry is LISTED and still reported
   by `DOUBLE_CLAIM`, but not added to the totals or the per-path summaries. Legacy payouts that prove
   no events, failed payouts, blocked/failed settlements and claimed settlements are unaffected.

Contract comments in `unified-finance.composer.ts` and `provider-finance.producer.ts` were updated.

## Tests

- `fin1-organizer-totals-after-refunds.integration-postgres.spec.ts` (8 tests, real Postgres):
  held after refunds; held + refunds = gross; fully refunded event not held; settlement pending nets
  refunds and equals the admin row (`gross - refundsMinor`); payout net equals what finance counts and
  the settlement is still listed with `DOUBLE_CLAIM`; pending + paid + payout.refund = gross bookings and
  `/payouts/summary` agrees with `/payouts/finance`; reads move no money.
- `provider-finance.producer.spec.ts` and `unified-finance.composer.spec.ts`: netting per status,
  clamping, claimed statuses unaffected, supersession boundaries, and a pin that the unmoved list is
  disjoint from `SETTLEMENT_CLAIMED_STATUSES`.
- Load-bearing: with the held netting disabled 3 integration tests fail; with the producer netting
  disabled 6 tests fail; with supersession disabled 6 tests fail. Each restored afterwards.

## Residual risk

- A pre-release settlement with `refundsMinor` accrued by a refund whose booking is not yet in the
  platform ledger's refund window could differ by the settlement's organizer-share rounding from the
  payout's `amountMinor` basis (191,809 vs 199,800 on QA). They are different ledgers with different
  fee bases; each is now internally consistent, but they are not expected to be equal numbers.
- A platform payout that proves no events (legacy) does not suppress an overlapping unmoved
  settlement, so such an org can still see both. The overlap is flagged by `DOUBLE_CLAIM` as before.
- An APPROVED settlement for an org that later links an account and whose payout is cancelled
  becomes counted again (correct: it can then release).
- Disputes are not netted from the pre-release entitlement (out of scope; not shown in the symptom).
- The API response gains `heldRevenue[].refundedMinor` (additive); web-kit types were left alone.

## Rollback

Revert the PR. No data, migration or configuration change was made.
