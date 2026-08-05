# Operational Runbook — External Inventory Sync (ADR-040)

Fast operational reference. **PostgreSQL is authoritative**; imported provider state is
advisory and never overwrites local sold/held inventory. All admin ops are RBAC-guarded
(ADMIN) + audited. No secrets/raw payloads are exposed.

## Feature flags (all default off)

`INVENTORY_SYNC_ENABLED` (master) · `_WEBHOOKS_ENABLED` · `_POLLING_ENABLED` ·
`_PROCESSING_ENABLED` · `_RECONCILIATION_ENABLED` · `_AUTO_REPAIR_ENABLED` ·
`INVENTORY_SYNC_PROVIDER_ALLOWLIST` · `INVENTORY_SYNC_MOCK_PROVIDER_ENABLED`.

## Investigate a failed webhook

1. Find the raw event: `SELECT id, "processingStatus", "attemptCount", "lastErrorCode",
"lastErrorMessage" FROM "RawProviderEvent" WHERE "providerCode"=$1 ORDER BY "receivedAt" DESC LIMIT 50;`
2. Status meaning: `RETRYABLE_FAILURE` (will retry), `PERMANENT_FAILURE`/`REJECTED`
   (terminal), `MANUAL_REVIEW` (needs a human), `DEAD_LETTERED` (exceeded attempts).
3. Reprocess after a fix: `POST /admin/inventory-sync/events/:id/reprocess`.

## Signature failure investigation

- Metric `etg_inventory_sync_ingest_total{outcome="verify_signature|verify_replay|..."}`.
- Invalid-signature events are NOT persisted (anti-DoS). Confirm the provider secret
  reference `inventory-sync/<code>/webhook-secret` is present + rotated correctly, the
  clock skew is within `INVENTORY_SYNC_REPLAY_WINDOW_SECONDS`, and the provider is on the
  allowlist. Never log or echo the expected signature.

## Queue backlog

- `etg_inventory_sync_process_total`, `etg_inventory_sync_processing_duration_seconds`,
  and `GET /admin/inventory-sync/providers/:code/health` (`queueBacklog`,
  `oldestUnprocessedAt`).
- The worker `inventory-sync-events` Worker + the `inventory-sync-sweep` job drain the
  backlog. If it grows, check worker health + `INVENTORY_SYNC_PROCESSING_ENABLED`.

## Reprocessing / retry

- Single event: `POST /admin/inventory-sync/events/:id/reprocess`.
- Bulk for a provider: `POST /admin/inventory-sync/providers/:code/retry-failed?limit=N`.
- Both are idempotent (the worker re-claims atomically).

## Mapping review

- List: `SELECT * FROM "ProviderMapping" WHERE status IN ('UNMAPPED','AMBIGUOUS','MANUAL_REVIEW');`
- Resolve (never guessed): `POST /admin/inventory-sync/mappings/:id/resolve` with
  `{ internalEntityType, internalEntityId }` → sets ACTIVE (audited).

## Checkpoint reset

`POST /admin/inventory-sync/providers/:code/checkpoint/reset` with `{ resource }` clears
the cursor to re-sync from the start (bounded). Never reset while a poll lease is held.

## Polling outage

- Metric `etg_inventory_sync_poll_total{outcome="skipped_lease|circuit_open|error"}`.
- Circuit-open is expected during a provider outage; webhook ingestion is unaffected.
  The lease auto-expires so another node takes over. To pause polling, set
  `INVENTORY_SYNC_POLLING_ENABLED=false`.

## Provider outage

Health goes DEGRADED/UNHEALTHY (`provider.health_changed` event +
`etg_inventory_sync_provider_health_total`). The circuit opens outbound calls. Imported
availability stays as the last-known advisory snapshot; local authoritative inventory is
unaffected. Do NOT fail provider-authoritative inventory over to local stock.

## Reconciliation

`POST /admin/inventory-sync/providers/:code/reconcile?limit=N` (detect-only). Classes:
MAPPING_REVIEW_REQUIRED / BOOKING_REVIEW_REQUIRED / PROVIDER_REFRESH_REQUIRED /
MANUAL_REVIEW. Booking conflicts NEVER auto-resolve — investigate the booking; PostgreSQL
wins. Watch `etg_inventory_sync_reconcile_total`.

## Circuit breaker

Opens after repeated poll failures (cooldown 60s, then a HALF_OPEN probe). Recovers
automatically on a successful probe. No manual reset endpoint — fix the provider and it
self-heals.

## Disable a provider

Remove it from `INVENTORY_SYNC_PROVIDER_ALLOWLIST` (webhooks then fail closed as unknown)
and it will not be polled. Queued events stop processing if you also unset the flag.

## Rollback

Set `INVENTORY_SYNC_ENABLED=false` (or the granular flags) and redeploy. No data
migration is needed to disable; PostgreSQL authoritative inventory is untouched. The
`RawProviderEvent`/`ProviderMapping`/`ProviderInventoryState`/checkpoint tables remain for
audit + later re-enable.

## Verify no local inventory corruption

Imported state is advisory (`ProviderInventoryState`) and separate from authoritative
inventory. Confirm authoritative correctness with the ADR-039 oversell checks
(`ShowSeat`/`TicketInventory`) — sync can never make those fail.
