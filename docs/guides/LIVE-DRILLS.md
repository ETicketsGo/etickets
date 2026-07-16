# Offline Gate — Live Drills, Activation Policy & Launch Report (ADR-035)

This document tracks the **launch gate** for offline gate check-in: the strict
activation policy, revocation-delta transport, the deterministic **drill harness**
proving the conflict/loss/reconciliation protocol, the **single-browser drill**
proving the scan UI + durable queue round-trip (M13), the **two-browser conflict
drill** proving exactly-one-ACCEPTED with a persisted evidence store that now drives
the gate (M14), the **device-loss drill** proving a revoked device is fail-closed
(M15), and the **reconciliation drill** proving the server always wins and no bad
admission is ever accepted (M16). With all three activation-gate drills now
evidence-backed green, offline gate activation remains **NO-GO** — by policy — until
the **recorded admin decision** (the controlled activation workflow) also exists.
Activation is always org/event/device-scoped; there is no global enable.

## Drill harness (M11) — results

Run at the service-integration level against the real `OfflineReconciliationService`
with a stateful DB simulation that honours the atomic ACTIVE→CHECKED_IN claim
(`apps/api/src/checkins/offline/offline-drills.spec.ts`). Machine-readable via Jest.

| Drill                                   | Assertion                                                                                                                   | Result  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Two-device conflict**                 | Two devices scan the same ticket offline → **exactly one** ACCEPTED, the other `DUPLICATE_OTHER_DEVICE`; no double check-in | ✅ PASS |
| **Device-loss**                         | A REVOKED device's queued check-ins are rejected; ticket never admitted                                                     | ✅ PASS |
| **Reconciliation mix**                  | valid / refunded / transferred (nonce rotated) / wrong-session classified correctly; server wins                            | ✅ PASS |
| **Connectivity flapping (idempotency)** | Re-submitting an accepted check-in → `DUPLICATE_SAME_DEVICE`, never a double                                                | ✅ PASS |

Pure logic backing these is unit-tested in `packages/…/offline-checkin.spec.ts`
(validator 12, reconciliation 5, deltas 3, activation policy 3).

**Still required before GO (browser/live):** the same four drills executed through
the organizer **offline scan UI + durable IndexedDB queue** across two real
browsers/devices, plus a deployment-during-event drill. Those depend on the UI
(below) and are recorded as activation evidence.

## Browser drill (M13) — result

Run through the **real organizer offline scan UI** (Chromium via Playwright,
`apps/e2e/tests/offline-gate-drill.spec.ts`) against a flag-on API. Self-discovers a
seeded session with an active ticket, then drives the browser panel end-to-end. It
`test.skip`s when the flag is off, so the default suite is unaffected.

| Step                         | Assertion                                                                | Result  |
| ---------------------------- | ------------------------------------------------------------------------ | ------- |
| Register + approve device    | Owner registers and approves this gate device (scoped to org/event)      | ✅ PASS |
| Download manifest            | Signed manifest cached to IndexedDB; ticket count shown                  | ✅ PASS |
| Offline validate             | `validateOfflineScan` → `VALID`; scan durably queued (`1 queued`)        | ✅ PASS |
| Local duplicate              | Same token re-scanned → `ALREADY CHECKED IN LOCAL`; not re-queued        | ✅ PASS |
| **Durability across reload** | Full page reload → queued scan still present (`1 queued`) from IndexedDB | ✅ PASS |
| Reconnect sync               | `Sync now` → server reconciles → `ACCEPTED` → queue drains (`0 queued`)  | ✅ PASS |

This proves the **client round-trip** — offline validate → durable queue → local
dedupe → survives restart → reconnect reconciliation — through the browser, not a
harness. It moves that leg of the gate from NO-GO to **CONDITIONAL_GO**.

## Two-browser conflict drill (M14) — result

Run through **two independent browsers** (`apps/e2e/tests/offline-gate-two-browser.spec.ts`),
each with its own device + IndexedDB, against a flag-on API. Both scan the SAME
ticket offline and queue it; on reconnect both sync **concurrently**, racing the
atomic `ACTIVE→CHECKED_IN` claim. Skips when the flag is off.

| Assertion                                                                          | Result  |
| ---------------------------------------------------------------------------------- | ------- |
| Both browsers queue the same ticket offline (independent devices)                  | ✅ PASS |
| Concurrent reconnect → **exactly one** `ACCEPTED`                                  | ✅ PASS |
| The losing device gets `DUPLICATE_OTHER_DEVICE` — never a second admit             | ✅ PASS |
| On PASS the drill records certification evidence; `drill_two_device` check → green | ✅ PASS |

This certifies the single most important safety property — **no double check-in
across devices** — through the real UI, exercising both the classify path and the
atomic-claim path. It is the first of the three activation-gate drills to earn
recorded evidence.

### Drill evidence store (M14)

Drill results are now **persisted** (`OfflineDrillRun`) and consumed by the
activation gate: `deriveActivationVerdict` reads a drill's check as passed only when
its latest recorded run is a `PASS` within a freshness window (`DRILL_EVIDENCE_TTL_MS`,
90 days) — **fail-closed**, so a drill never run, last-failed, or stale keeps the
gate closed. `POST /checkin/drills` records a result (manager-only, flag-gated);
`GET /checkin/drills` lists them. This replaces the previously hardcoded `false`
drill inputs — evidence, not assumption, drives the gate.

**Still required before GO:** the **device-loss** (M15 below) and reconciliation
browser drills, and the **recorded admin activation** (the controlled activation
workflow — priority 7, not yet built).

## Device-loss browser drill (M15) — result

Run through the **real organizer scan UI** (`apps/e2e/tests/offline-gate-device-loss.spec.ts`)
against a flag-on API. A device queues an offline scan, is then **REVOKED** (lost /
reported stolen) while the scan is still queued, and reconnects. Skips when the flag
is off.

| Assertion                                                                          | Result  |
| ---------------------------------------------------------------------------------- | ------- |
| Scan validates + queues while the device is still ACTIVE                           | ✅ PASS |
| After revoke, reconnect sync is rejected — reconcile returns **403** (fail-closed) | ✅ PASS |
| The queued scan is **not** silently dropped (stays queued for a valid device)      | ✅ PASS |
| Server truth: the ticket was never admitted — still `ACTIVE` + eligible            | ✅ PASS |
| On PASS the drill records evidence; `drill_device_loss` check → green              | ✅ PASS |

This certifies that **a lost device can never admit anyone offline**: the server
rejects a revoked device's entire queue at reconcile ([offline-reconciliation.service.ts](../../apps/api/src/checkins/offline/offline-reconciliation.service.ts))
and nothing is accepted. It is the second activation-gate drill to earn recorded
evidence. After M15, `drill_two_device` and `drill_device_loss` are green; the
gate stays **NO_GO** — `drill_reconcile` is still fail-closed and admin activation
is unrecorded.

## Reconciliation browser drill (M16) — result

Run through the **real panel + the reconcile engine** (`apps/e2e/tests/offline-gate-reconciliation.spec.ts`)
against a flag-on API. The panel drives the valid offline→queue→sync→ACCEPTED
round-trip; then a deterministic divergence matrix is replayed through the real
`POST /checkin/reconcile` using the panel's approved device. Skips when the flag is
off.

| Assertion                                                                        | Result  |
| -------------------------------------------------------------------------------- | ------- |
| Panel: a valid offline scan reconciles to `ACCEPTED` (queue drains)              | ✅ PASS |
| Wrong-session queued item → `WRONG_SESSION` (never accepted)                     | ✅ PASS |
| Rotated nonce (transfer after download) → `TRANSFERRED_AFTER_DOWNLOAD`           | ✅ PASS |
| Vanished ticket → `SUPERVISOR_REVIEW_REQUIRED`                                   | ✅ PASS |
| The contended ticket is **never admitted** by any rejected case (stays `ACTIVE`) | ✅ PASS |
| Determinism: the same invalid input yields the same outcome                      | ✅ PASS |
| A correct scan is `ACCEPTED` exactly once; a replay → `DUPLICATE_SAME_DEVICE`    | ✅ PASS |
| Every reconcile is audited (`OFFLINE_CHECKIN_RECONCILED` in the admin audit log) | ✅ PASS |

This certifies that **the server always wins and no invalid admission is ever
accepted** — refund/transfer/wrong-session/vanished are surfaced, valid is admitted
exactly once, replays are idempotent, outcomes are deterministic, and the trail is
auditable. It is the **third and final** activation-gate drill to earn recorded
evidence. After M16 all three drill checks are green; the gate stays **NO_GO** only
on the **recorded admin activation**.

## Revocation deltas (M5)

`GET /checkin/deltas?eventSessionId&sinceMs` returns a **signed, incremental**
delta of tickets changed since the device's last version (refund/cancel/transfer/
nonce-rotation/void/checked-in-elsewhere). The device applies it atomically
(`applyDelta`) or, on a **gap** (`hasDeltaGap`) or rollback, refetches the full
manifest — never a partial apply. When delta age exceeds policy, high-risk tickets
fall back to `REQUIRES_ONLINE_VALIDATION`. All pure logic is unit-tested.

## Activation policy (M12)

`deriveActivationVerdict` (pure, tested) is the strict launch gate. **GO** requires
every gate: flag enabled, org/event/device approved, valid manifest, fresh deltas,
operational queue/reconciliation/alerts/audit, **all three drills passed**, zero
open Critical/High findings, and a **recorded admin activation**. Any _blocking_
check failing → **NO_GO**; only non-blocking gaps → **CONDITIONAL_GO**.
`mustDowngrade` forces an immediate mid-event **NO_GO** on device revoke, manifest
expiry, stale delta, queue corruption, or audit/reconciliation/security-config
failure.

`GET /checkin/activation` reports the current verdict. As of M16 **all three** drill
checks are evidence-backed green (two-device, device-loss, reconciliation); the only
remaining blocking check is the **recorded admin activation**, so it still returns
**NO_GO** — an honest state, not a false GO. Drill inputs are read from the
persisted evidence store (fail-closed), not hardcoded.

## Launch report — GO / NO-GO

| Item                                                                                         | Status                                                    |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Offline check-in **protocol** (validator, reconciliation, manifest, deltas, activation gate) | ✅ shipped + tested                                       |
| Service-level drills (conflict / loss / reconciliation / flapping)                           | ✅ PASS                                                   |
| Storage eviction (customer)                                                                  | ✅ shipped (Sprint 8)                                     |
| Organizer offline **scan UI + durable queue** (single-browser round-trip)                    | ✅ shipped + browser drill PASS → **CONDITIONAL_GO**      |
| **Two-browser conflict** drill (exactly one ACCEPTED) + recorded evidence                    | ✅ PASS (M14) — `drill_two_device` green                  |
| **Device-loss** drill (revoked device fail-closed) + recorded evidence                       | ✅ PASS (M15) — `drill_device_loss` green                 |
| **Reconciliation** drill (server wins, no bad admission) + recorded evidence                 | ✅ PASS (M16) — `drill_reconcile` green                   |
| Offline gate **activation**                                                                  | ⛔ **NO-GO** — needs the recorded admin decision only     |
| Native wallet passes                                                                         | ⛔ **NO-GO** — needs real Apple/Google issuer credentials |

## Remaining engineering (documented; not shipped this sprint)

Front-end + ops work that the protocol above is now ready for. Items 3–4 shipped
this sprint (see [OFFLINE-OPERATIONS.md](OFFLINE-OPERATIONS.md)); the rest remain:

1. **Organizer device-management UI** (register/approve/suspend/revoke/report-lost)
   over the existing device API. _(This sprint ships self-register + approve for the
   scanning device; full lifecycle management is still pending.)_
2. **Offline preflight** checklist gating offline mode (device active, manifest
   valid, delta fresh, clock drift, queue reconciled, readiness GO/CONDITIONAL_GO).
3. ✅ **Durable IndexedDB check-in queue** — shipped (`checkin-queue.ts`): PENDING/
   SYNCING/ACCEPTED/DUPLICATE/CONFLICT/REVIEW_REQUIRED/REJECTED, local duplicate
   ledger, ordered idempotent sync, never delete before server ack. _(Multi-tab lock
   - backoff/dead-letter still pending.)_
4. ✅ **Offline scan UI** using `validateOfflineScan` — shipped (`offline-checkin.tsx`):
   large text + icon result, never colour-only.
5. **Reconciliation console** + **supervisor override UI** (permitted states only;
   default-deny; additive audit-only resolutions).
6. **Live Event Command Center** + **event-day alerting** (throttled/deduped) over
   the existing analytics/metrics.
7. **Wallet-pass sandbox** (`WalletPassProvider` + Apple/Google adapters, fail-
   closed, test-mode only).
8. ✅ **Browser drills executed + recorded** — two-browser conflict (M14),
   device-loss (M15) and reconciliation (M16) all PASS + recorded. All three
   `drill_*` activation checks are green.
9. **Controlled activation workflow** — the recorded org/event/device admin decision
   (`adminActivationRecorded`), now the **only** remaining blocking gate before GO.

## Recommendation

The protocol, its gate, the **scan UI + durable queue**, and **all three
activation-gate drills** (two-browser conflict, device-loss, reconciliation — with a
persisted, fail-closed evidence store now driving the gate) are proven. Exactly one
blocking check remains: the **controlled activation workflow** (the recorded
org/event/device admin decision). Once that lands and is recorded, `GET /checkin/activation`
can reach GO for a scoped pilot; the reconciliation console + command center then add
operational visibility. Do not enable offline gate mode at a real event until the
admin activation is recorded; `GET /checkin/activation` remains the enforced source
of truth and still returns NO_GO.
