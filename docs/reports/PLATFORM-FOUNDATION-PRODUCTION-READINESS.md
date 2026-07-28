# Platform Foundation — Production Readiness Review (P1–P4 + P2.1)

- **Reviewer:** Principal Architect / Release Engineer
- **Date:** 2026-07-27
- **Branch:** `feat/inventory-sourcing-platform`
- **Verdict:** **CONDITIONAL GO** — all code/security/migration/correctness gates PASS; the
  remaining conditions are **staging-only** (multi-instance validation, fresh-DB migrate,
  scaled performance/failure-injection) plus a **merge-composition decision** (the branch
  also carries the unmerged payments track). No unresolved code, security, migration, or
  correctness defect.

## Scope reviewed

ADR-037 inventory sourcing · ADR-038 domain event bus · ADR-039 distributed Redis
locking · ADR-040 external inventory sync · ADR-041 transactional outbox. 41 platform
commits (+ 15 payments commits, see merge finding). 189 files changed, +20.6k/−80.

## Architecture summary

A modular monolith with five feature-flagged seams, all defaulting off, all leaving the
existing booking path unchanged when disabled. PostgreSQL is authoritative throughout;
Redis is fast coordination; the outbox makes domain-event delivery durable. Each seam has
a DI-boot test, unit + integration tests, health, metrics, admin ops (RBAC + audited),
and a runbook.

## Verification gates (all executed here)

| Gate                                       | Result                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Full API suite                             | **903 tests / 133 suites PASS**                                                           |
| P3 real-Redis concurrency (re-run)         | **9/9 PASS** (executed against live Redis, not skipped)                                   |
| Config-matrix (new)                        | **11/11 PASS**                                                                            |
| `tsc --noEmit` (api)                       | clean                                                                                     |
| Worker typecheck + build (after api build) | clean                                                                                     |
| Prettier (api + worker)                    | clean                                                                                     |
| `prisma validate` / `migrate status`       | valid / up to date                                                                        |
| Migration ordering                         | 31 migrations, sorted + unique                                                            |
| Secret / history scan                      | no `.env`, keys, PEM, live secrets, conflict markers, debug logging, or correctness TODOs |

Not run here (documented as staging items, not claimed): fresh-from-scratch `migrate
reset` apply, multi-instance dispatcher/lock validation, scaled performance baseline,
full failure-injection at load.

## Merge finding (important)

`merge-base(main, HEAD) = d8de6ff`. The branch was cut from `feat/stripe-connect-us`, so
the 56-commit range = **15 payments commits (Stripe Connect + Razorpay — NOT merged to
main)** + 41 platform commits. Platform commits modify payment files (P2.1 proof slice), so
the two cannot be cleanly separated. `main == origin/main`. **Merging this branch lands
the payments track too.** Both tracks are feature-flagged, tested, and safe-by-default;
the payments track's prior verdict was READY WITH MANUAL CONFIGURATION. **Decision for the
owner:** merge as one reviewed unit, or land the payments PR first. This is a
composition/sequencing decision, not a defect.

## Feature-flag matrix (defaults are SAFE; startup validation now enforced)

| Flag                                                                                 | Default        | Notes                                    |
| ------------------------------------------------------------------------------------ | -------------- | ---------------------------------------- |
| INVENTORY_SOURCING_ENABLED / INVENTORY_AGGREGATOR_ENABLED                            | false / false  | aggregator fails closed                  |
| INVENTORY_PROVIDER_PRIORITY                                                          | unset          | LOCAL-first default                      |
| DOMAIN_EVENTS_ENABLED                                                                | false          | publish no-op when off                   |
| DOMAIN_EVENT_HANDLER_TIMEOUT_MS                                                      | 5000           |                                          |
| INVENTORY_LOCKS_ENABLED / _MODE                                                      | false / shadow | active rejected in prod (not P5-wired)   |
| INVENTORY_LOCK_TTL/RENEWAL/MAX_LIFETIME_SECONDS                                      | 300/120/900    |                                          |
| INVENTORY_LOCK_RECONCILIATION_ENABLED                                                | false          |                                          |
| INVENTORY_SYNC_ENABLED + _WEBHOOKS/_POLLING/_PROCESSING/_RECONCILIATION/_AUTO_REPAIR | all false      | sync-enabled + empty allowlist rejected  |
| INVENTORY_SYNC_PROVIDER_ALLOWLIST                                                    | empty          | empty ⇒ nothing accepted                 |
| INVENTORY_SYNC_MOCK_PROVIDER_ENABLED                                                 | false          | **rejected in production**               |
| DOMAIN_EVENT_DELIVERY_MODE                                                           | in_process     | outbox-without-dispatch rejected in prod |
| DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED                                                 | false          |                                          |
| DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED                                                | false          | purge off unless enabled                 |

`assertPlatformConfigConsistency` (new) fails fast on: mock-in-prod, sync-without-allowlist
(any env), outbox-without-dispatch-in-prod, active-locking-in-prod. Missing env vars use
safe zod defaults; invalid combos throw a clear config error at boot.

## Migration inventory (durable structures added)

ProviderMapping, RawProviderEvent, ProviderSyncCheckpoint, ProviderInventoryState (P4;
`20260727120420`); OutboxEvent, ProcessedDomainEvent (P2.1; `20260727194418`); Payment
+providerOrderId/providerStatus, Stripe-Connect settlement/dispute tables (payments). All
additive; **no destructive change to existing booking/payment data**; unique constraints
enforce documented idempotency; required indexes present. Down migrations are not used in
this repo → forward-fix rollback (disable flags; a follow-up migration if a structure must
change). High-growth tables (RawProviderEvent, OutboxEvent) have retention policies (off
by default).

## Runtime component inventory

Controllers: `POST /webhooks/inventory/:providerCode` (public, signature-verified),
`/admin/inventory-sync/*` + `/admin/outbox/*` (ADMIN RBAC + audit). Workers (all no-op
when their flag is off): holds sweep (existing), `inventory-sync-events` Worker + sweep,
`outbox-dispatch` + `outbox-maintenance`. One BullMQ `holds` queue + one
`inventory-sync-events` queue. Redis Lua (seat/quantity acquire/renew/release) + keys
env-scoped, no PII, no client-supplied keys. Raw SQL is parameterized everywhere (no
`queryRawUnsafe`).

## Security findings

Parameterized SQL; constant-time HMAC + replay window + size limit + allowlist +
provider-code validation on the public webhook; invalid signatures not persisted; admin
ops RBAC + audited, safe-metadata-only, no payload/identity edits; no secrets/PII in
payloads, Redis keys, metric labels, logs, or error responses; tenant/actor metadata
preserved (no cross-tenant replay via the API); worker identity server-side. **No
findings requiring a fix.**

## Transaction-correctness findings

PostgreSQL authoritative; no event/cache before commit; no provider payload mutates domain
state (imports are advisory `ProviderInventoryState`); Redis success never = a sale;
duplicate payment/provider callbacks idempotent; BookingConfirmed recorded exactly once
(alreadyConfirmed guard); a failed **required** outbox insert rolls the business tx back;
shadow modes never change customer-visible outcomes. Outbox same-aggregate ordering: newer
sibling blocked while an earlier PENDING/PROCESSING/RETRYABLE sibling exists; a
DEAD_LETTERED/terminal sibling releases later events; different aggregates concurrent;
lease expiry does not let a later event bypass an earlier one. **All covered by tests.**

## Performance / failure-injection

Local unit/integration timings are healthy (outbox claim/serialize, lock acquire sub-10ms
in real-Redis tests; full suite ~40s). A scaled baseline vs merge base and load-level
failure injection are **staging items** (see checklist) — not claimed from local runs.
Failure semantics (Redis outage per mode, outbox insert failure→rollback, dispatcher
crash→lease recovery, poison→dead-letter, duplicate/stale/invalid webhook) are unit/
integration-tested and match the ADRs/runbooks.

## Observability findings

Metrics for sourcing/locking/contention/reconcile/sync/webhook/poll/provider-health/
outbox-backlog/delivery/replays/dead-letters/stale/cache-failure. Labels bounded (no ids/
PII); durations in seconds; health states match feature modes; read-only APIs are not
gated by worker lag; outbox reports UNHEALTHY when dispatch is required but off. A
dashboard/alert spec is a documented follow-up (thresholds are deployment-specific).

## Known limitations

- Cache keys are not env-namespaced (pre-existing `CacheService` convention; low risk with
  per-deployment Redis + short TTL) — noted for a future hardening pass.
- Redis Cluster: multi-key Lua scripts assume a single logical Redis (hash-slot
  co-location not enforced) — documented; single-instance/Sentinel supported, Cluster is a
  future concern (ADR-039 deferred).
- Active distributed locking + provider booking confirmation are **not wired into the
  booking path** — that is P5. Startup validation blocks active-mode-in-prod.
- Full bidirectional lock↔booking reconciliation needs a persisted booking `lockId`
  (deferred to P5).

## Operational dependencies

PostgreSQL (authoritative), Redis (coordination + cache), BullMQ worker. All new async
work is worker-side and idempotent; a lost queue signal never loses an outbox event
(polling recovers).

## Staging requirements (must be executed in staging before enabling any flag in prod)

See the staging checklist section below — none are marked complete (not executed here).

## Activation sequence (per-flag, staged)

1. Deploy with all flags off (== current behaviour). 2. `INVENTORY_SOURCING_ENABLED` (manual
   provider). 3. `DOMAIN_EVENTS_ENABLED` in-process → observe. 4. `DOMAIN_EVENT_DELIVERY_MODE=
dual_write_shadow` → compare counts. 5. `outbox` + dispatch on, delivering to
   BookingEventRecorder only. 6. `INVENTORY_LOCKS_ENABLED` shadow → measure. 7. Sync: allowlist

- secrets → webhooks → processing → reconciliation. Enable retention last. Never enable
  mock providers or irreversible handlers in prod.

## Rollback strategy

Set the relevant flag(s) to their defaults and redeploy — every seam degrades to the
legacy path with no data migration. Durable tables remain for audit/re-enable. No down
migrations; forward-fix only.

## Final decision

**CONDITIONAL GO.** Merge is recommendable once the owner accepts the merge composition
(payments + platform) and the staging checklist is executed. No code fix is outstanding.

---

# Staging Validation Checklist (none executed here — must be run in staging)

- [ ] Deploy ≥2 API + ≥2 worker instances against production-like PostgreSQL + Redis.
- [ ] Confirm one shared Redis namespace; workers claim **disjoint** outbox rows (no double-claim).
- [ ] Kill a worker mid-claim → confirm its lease expires and rows re-claim; no strand.
- [ ] Confirm outbox same-aggregate ordering across workers; a dead-letter releases later events.
- [ ] Redis seat/quantity lock contention across API instances → no oversell, one winner.
- [ ] Valid signed webhook through the real proxy/LB → **raw body preserved** → signature verifies.
- [ ] Polling lease owned by exactly one node; failover on node loss.
- [ ] Queue unavailability → PENDING outbox rows still deliver on recovery (no loss).
- [ ] Fresh-DB `migrate reset` apply + upgraded-DB apply; measure migration runtime on prod-sized data.
- [ ] Metrics scrape + alerts fire; admin RBAC enforced; feature flags flip safely.
- [ ] Roll back to all-disabled → existing booking flow fully functional.
- [ ] Booking/confirmation latency vs merge base within budget (no material regression).
