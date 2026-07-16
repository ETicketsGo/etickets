# Offline Gate — Live Drills, Activation Policy & Launch Report (ADR-035)

This sprint completed the **launch gate** for offline gate check-in: the strict
activation policy, revocation-delta transport, and a deterministic **drill
harness** proving the conflict/loss/reconciliation protocol end-to-end. Offline
gate activation remains **NO-GO** — by policy — until the browser scan UI + live
browser drills are also recorded. Activation is always org/event/device-scoped and
requires a recorded admin decision; there is no global enable.

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

`GET /checkin/activation` reports the current verdict. Today it returns **NO_GO**:
the browser drills and admin activation are not yet recorded — an honest state, not
a false GO.

## Launch report — GO / NO-GO

| Item                                                                                         | Status                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Offline check-in **protocol** (validator, reconciliation, manifest, deltas, activation gate) | ✅ shipped + tested                                                 |
| Service-level drills (conflict / loss / reconciliation / flapping)                           | ✅ PASS                                                             |
| Storage eviction (customer)                                                                  | ✅ shipped (Sprint 8)                                               |
| Offline gate **activation**                                                                  | ⛔ **NO-GO** — needs scan UI + live browser drills + admin decision |
| Native wallet passes                                                                         | ⛔ **NO-GO** — needs real Apple/Google issuer credentials           |

## Remaining engineering (documented; not shipped this sprint)

Front-end + ops work that the protocol above is now ready for:

1. **Organizer device-management UI** (register/approve/suspend/revoke/report-lost)
   over the existing device API.
2. **Offline preflight** checklist gating offline mode (device active, manifest
   valid, delta fresh, clock drift, queue reconciled, readiness GO/CONDITIONAL_GO).
3. **Durable IndexedDB check-in queue** (states PENDING…DEAD_LETTER, multi-tab
   lock, ordered idempotent sync, backoff, never delete before server ack).
4. **Offline scan UI** using `validateOfflineScan` (large text + icon + optional
   sound; never colour-only).
5. **Reconciliation console** + **supervisor override UI** (permitted states only;
   default-deny; additive audit-only resolutions).
6. **Live Event Command Center** + **event-day alerting** (throttled/deduped) over
   the existing analytics/metrics.
7. **Wallet-pass sandbox** (`WalletPassProvider` + Apple/Google adapters, fail-
   closed, test-mode only).
8. Execute + record the **live browser drills**, then flip activation per policy.

## Recommendation

The protocol and its gate are proven. Per the CTO steer, the next step is a **small
customer-offline pilot** (Sprint 8 wallet, no organizer offline mode required) plus
building the organizer offline UI on this foundation — then run the live browser
drills and record the activation decision. Do not enable offline gate mode at a
real event until those drills pass.
