# Reconciliation Operations Guide

Finance reconciliation surfaces differences between our records and provider truth
into a triage queue (ADR-029). **Financial records are never auto-corrected** —
resolution is a human, audited decision. Console: `/admin/finance-reconciliation`.

## Discrepancy types

Payment missing internally, payment missing at provider, amount mismatch, currency
mismatch, duplicate capture, refund mismatch, chargeback, settlement mismatch,
gateway-fee mismatch, organizer-payable mismatch.

Auto-detected today: missing-at-provider, amount, currency, unsettled status
(via provider `getPayment`), duplicate capture and over-refund (internal invariants).
The remaining types are modelled for manual filing / future provider-report ingestion.

## Daily job

The worker runs `reconcile-finance` every 24h (`RECONCILE_INTERVAL_MS`), calling
detection over the last 25h. Detection is idempotent — it never files a second open
discrepancy for the same (env, type, entityRef).

## Triage workflow

1. **Detect** on demand: `POST /admin/payments/finance/detect?from&to`.
2. **Review** the queue (`GET .../discrepancies`) and **aging** (`GET .../aging`,
   buckets 0-1d / 1-3d / 3-7d / 7-30d / 30d+).
3. **Assign** (`POST .../:id/assign`), then **Resolve** with notes
   (`POST .../:id/resolve`) or **Ignore** (`POST .../:id/ignore`).
4. **Export**: `GET .../discrepancies.csv` (RFC-4180 escaped) for finance sign-off.

Every detection run and triage action is written to the audit log.

## Escalation

- Rising `30d+` aging → escalate; a persistent settlement/gateway-fee mismatch is a
  provider-side ticket.
- A duplicate capture or over-refund is a **correctness** issue — investigate the
  booking + provider dashboard before resolving; correct records only through the
  provider's approved refund/adjustment flow.
