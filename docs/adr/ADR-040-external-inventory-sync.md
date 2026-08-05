# ADR-040: External Inventory Synchronization Platform

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Principal Architect
- **Relates to:** ADR-037 (Inventory Sourcing), ADR-038 (Domain Event Bus), ADR-039 (Distributed Locking)
- **Scope:** P4 — the vendor-neutral ingestion/normalization/sync/reconciliation/health layer only

## Context (audit findings)

- **Durable webhook pattern** exists for payments: `WebhookEvent` (dedup via
  `@@unique([provider, providerEventId])`, `processingStatus`, `attempts`, atomic-claim
  processors swept on worker intervals). P4 **mirrors** this shape rather than reusing
  the payments table.
- **Raw body** is globally enabled (`rawBody: true`) → reused for signature verification.
- **SecretManager** (`SECRET_MANAGER`, `getSecret(reference)`) → reused for provider
  webhook secrets (references only, never raw secrets in source/logs/metrics).
- **BullMQ** — a single `holds` queue + interval sweeps; **no** second queue framework
  was added beyond one focused `inventory-sync-events` queue.
- **CircuitBreaker** (`payments/orchestration`) with an injected clock → **reused** for
  provider polling.
- **P2 DomainEventBus** already reserved `inventory.sync_*` + `provider.health_changed`.
- **No external-id columns** on domain models → a durable `ProviderMapping` table is
  added instead of invasive per-table columns.
- **No cache-invalidation helper** → a targeted, best-effort `CacheService.invalidateByPattern`.

## Decision

Add a provider-neutral external inventory sync platform under
`apps/api/src/inventory/sync/`. External providers are **untrusted inputs**: every
payload is authenticated, size-limited, verified, deduplicated, persisted raw,
normalized to a **canonical** vocabulary, mapped, version-ordered, applied
transactionally to ADVISORY state, and reconciled. A raw external payload NEVER updates
ETicketsGo tables directly, and imported availability NEVER overwrites authoritative
local inventory.

### Push vs pull

- **Push (webhook):** `POST /webhooks/inventory/:providerCode` → verify (fail closed) →
  size-limit → persist raw (dedup) → enqueue (id only) → fast ack. No heavy work in the
  HTTP request.
- **Pull (polling):** a checkpoint-leased coordinator walks `fetchChanges` pages,
  persists each record via the SAME durable path, and advances the cursor ONLY after a
  page is fully accepted.

### Raw-event persistence

`RawProviderEvent` stores providerCode/tenant/externalEventId, type/version, hashes,
payload JSON, signature + processing status, attempts, correlation, and errors — enough
to reprocess, investigate, and reconcile. Identity =
`(providerCode, providerTenantId, externalEventId)`; when the provider has no stable id,
a **deterministic key** from safe normalized fields + payload hash is used (never the
receipt timestamp). Retention is bounded (`INVENTORY_SYNC_EVENT_RETENTION_DAYS`).

### Provider adapters + canonical model

Each provider implements `InventorySyncProvider` (verify/parse/fetch/normalize/health).
Provider-specific types never leak past the adapter — everyone else sees only
`CanonicalInventoryChange` (upsert experience/venue/screen/layout/session, update
pricing/seat-availability/quantity-availability, cancel session, provider booking/refund
status). Two reference adapters ship: **Manual** (LOCAL_AUTHORITATIVE, no ingress) and a
dev/test-only **Mock aggregator** (flag-gated; HMAC + replay + Zod normalization +
simulation). No real vendor is integrated.

### Mapping strategy

`ProviderMapping` durably links an external entity to an internal one, unique per
`(providerCode, tenant, externalEntityType, externalEntityId)` — one external id maps to
at most one internal record in scope. Ambiguity is never guessed: it becomes
`AMBIGUOUS`/`MANUAL_REVIEW` and fails safe. States: ACTIVE / UNMAPPED / AMBIGUOUS /
DISABLED / DELETED / MANUAL_REVIEW.

### Idempotency + ordering

At-least-once everywhere: the unique raw-event constraint dedupes deliveries; the BullMQ
`jobId = rawEventId` dedupes enqueues; the worker claims atomically; reprocessing is a
no-op. Ordering per entity: `incomingVersion > storedVersion` applies, `<` is stale
(ignored), `=` with the same payload hash is a duplicate (ignored) and `=` with a
different hash is an **ordering conflict** → review. With no version, provider timestamps
are compared (older = stale). A late "AVAILABLE" can never overwrite a newer
"SOLD"/"CANCELLED".

### Inventory ownership modes

`LOCAL_AUTHORITATIVE` — ETicketsGo owns state; external events can't override local
sold/held (availability imports are ignored + recorded). `PROVIDER_AUTHORITATIVE` — the
provider owns state; ETicketsGo imports it as an advisory `ProviderInventoryState`.
`ALLOCATED` — bounded allocation (advisory + reconciliation). Mode lives on the mapping

- the adapter capability; providers are not treated identically.

### Sync transaction

Load mapping → validate ownership/scope → order → transactional mutation of ADVISORY
state → COMMIT → cache invalidation → domain events. Cache/events happen ONLY after
commit; on post-commit cache failure the commit stands and reconciliation is recorded
(never a rollback). Uses the P2 bus; no BullMQ in domain services.

### Queue + retry

One `inventory-sync-events` queue; jobs carry only `{rawEventId, providerCode,
correlationId}`; the worker reloads from PostgreSQL. Failures are classified
(retryable-provider / retryable-infra / permanent-schema / mapping-ambiguity /
unsupported-version / security-rejection / manual-review). Retryable retries with
exponential backoff up to `INVENTORY_SYNC_MAX_ATTEMPTS` then DEAD_LETTERED; permanent /
security / mapping / version go straight to a terminal state — never an endless loop.

### Reconciliation + health + circuit breaker

Bounded reconciliation classifies drift (mapping review, terminal events, stale
checkpoints; booking/refund → protected BOOKING_REVIEW) and auto-repairs only
unambiguous cases (gated) — never auto-cancels/refunds a confirmed booking. Health is
derived from durable signals (backlog, dead-letters, oldest unprocessed) + the adapter's
own health, emits `ProviderHealthChanged` on transitions, and informs routing only via
explicit rules (never auto-fails provider stock over to local). The existing
CircuitBreaker guards outbound polling; webhook ingestion keeps working while polling is
circuit-open.

### Security model (threat model)

External providers are hostile until proven otherwise: raw-body HMAC/asymmetric/token
verification (constant-time), replay window on timestamped signatures, size limit,
provider allowlist, provider-code `[a-z0-9_-]` validation (path/key-injection), safe
JSON parsing with bounded arrays, secret isolation via SecretManager (never in
logs/metrics/records), no client-supplied Redis keys or fencing tokens, no arbitrary
internal-entity mapping from webhook input, RBAC + audit on ops, and safe error
responses (no secrets/expected-signatures/topology). Invalid signatures are not
persisted (spoofed-traffic storage DoS).

### Feature-flag rollout

`INVENTORY_SYNC_ENABLED` + granular `_WEBHOOKS_/_POLLING_/_PROCESSING_/_RECONCILIATION_/
_AUTO_REPAIR_ENABLED` (all off) — no flag half-activates an unsafe path. The webhook
route fails closed (unknown) when disabled. `INVENTORY_SYNC_MOCK_PROVIDER_ENABLED` gates
the mock adapter.

## Consequences

**Positive** — durable, reprocessable, idempotent ingestion; provider isolation via the
canonical model; safe ordering/ownership; advisory imports that never corrupt
authoritative inventory; reconciliation + health + circuit protection; zero behaviour
change when disabled.

**Negative / limitations** — imported state is advisory only (no booking-time provider
confirmation — deferred); the DB→provider reconciliation direction is bounded; no real
vendor is integrated; cache invalidation is prefix-targeted pending per-entity cache
tags.

## Deferred (future work)

Real vendor integration (with official access); full InventoryResolver integration into
booking orchestration; cross-provider failover; provider booking confirmation at
checkout; P2.1 transactional outbox; active Redis lock enforcement; dynamic pricing;
waiting room; bot detection; theatre portal UI; settlement changes; multi-region sync;
Kafka/SNS/SQS/EventBridge; microservice extraction.

## Compliance / verification

126 suites / 869 API tests green (+56 sync); worker typecheck green; tsc + prettier
clean; migration applied. Tests cover signature/replay/size, dedup + deterministic key,
normalization + unknown-enum rejection, minor-unit preservation, version ordering
(v5-after-v4, v4-not-over-v5, dup ignored, conflict review), ownership modes, cache +
events after commit, retry/permanent/dead-letter classification, checkpoint lease,
polling (lease/circuit/cursor-after-accept), reconciliation classes, health transitions,
registry allowlist/injection, and a Nest DI boot.
