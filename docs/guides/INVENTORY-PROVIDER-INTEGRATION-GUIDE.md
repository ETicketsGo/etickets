# Inventory Provider Integration Guide

How to add a new external inventory provider to the ETicketsGo sync platform
(ADR-040). Provider-specific types must stay behind the adapter; everyone else consumes
only the canonical vocabulary. **Do not integrate a real vendor without official
documentation and valid sandbox credentials.**

## 1. Register provider configuration

- Add the provider code (lowercase `[a-z0-9_-]`) to `INVENTORY_SYNC_PROVIDER_ALLOWLIST`.
- Store the webhook secret in the SecretManager under
  `inventory-sync/<providerCode>/webhook-secret` (a reference — never in source).
- Decide the ownership mode: `LOCAL_AUTHORITATIVE`, `PROVIDER_AUTHORITATIVE`, or
  `ALLOCATED`.

## 2. Implement the adapter

Create `apps/api/src/inventory/sync/providers/<provider>-sync.provider.ts` implementing
`InventorySyncProvider` (`providerCode`, `ownershipMode`, `supportsWebhooks`,
`supportsPolling`, and the methods below). Register it in `InventorySyncModule`
(behind a flag if it is not production-ready). Keep all vendor types inside this file.

## 3. Implement signature verification

`verifyWebhook({ rawBody, headers, secret, replayWindowSeconds })` — verify against the
RAW body with a **constant-time** compare; check the timestamp within the replay window;
return `{ valid, reason?, providerTenantId? }`. Fail closed (`valid:false`) when the
secret or signature is missing. Never log the signature or secret.

## 4. Define provider schemas

Model the vendor payload with Zod (or equivalent). Reject unknown enum values and
unsupported types **visibly** — never silent-default to a valid state.

## 5. Normalize to canonical changes

`normalize(event)` → `CanonicalInventoryChange[]`. Preserve minor-unit + currency exactly
(no conversion), stable external seat ids (never display labels), and external version /
provider timestamps for ordering. Throw a typed sync error for unsupported input.

## 6. Configure mappings

External entities start `UNMAPPED`. Link them to internal entities via
`SyncOpsService.resolveMapping` (admin) — never guess. Ambiguous cases go to
`MANUAL_REVIEW`.

## 7. Add webhook route support

None needed — `POST /webhooks/inventory/:providerCode` already routes to your adapter by
code once it is registered + allowlisted.

## 8. Add polling support (if required)

Set `supportsPolling = true` and implement `fetchChanges({ cursor, pageSize, since })`
returning `{ records, nextCursor, hasMore }`. The coordinator handles the lease,
persistence, and checkpoint advancement — never advance the cursor yourself.

## 9. Add fixtures

Provide signed webhook fixtures and paginated polling fixtures for tests (see the mock
aggregator's `static sign(...)`).

## 10. Add contract tests

Cover verify (valid/invalid/replay/missing-secret), parse, normalize (each type + unknown
enum + unsupported type + precision), and pagination — mirroring
`mock-aggregator-sync.provider.spec.ts`.

## 11. Add health reporting

Implement `health()` returning `HEALTHY | DEGRADED | UNHEALTHY | DISABLED | UNKNOWN`. The
platform combines it with durable backlog/dead-letter signals.

## 12. Complete the security review

Confirm: raw-body verification, constant-time compare, replay protection, size limit,
allowlist, secret isolation, no secrets in logs/metrics, safe error responses, bounded
arrays, provider-code validation, no arbitrary internal mapping from input.

## 13. Activate through feature flags

Enable in order, verifying at each step: `INVENTORY_SYNC_ENABLED` →
`_WEBHOOKS_ENABLED` / `_POLLING_ENABLED` → `_PROCESSING_ENABLED` →
`_RECONCILIATION_ENABLED`. Keep `_AUTO_REPAIR_ENABLED` off until reconciliation output is
trusted.
