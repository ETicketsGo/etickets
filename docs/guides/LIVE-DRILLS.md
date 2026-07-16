# Offline Gate — Live Drills, Activation Policy & Launch Report (ADR-035)

This document tracks the **launch gate** for offline gate check-in: the strict
activation policy, revocation-delta transport, the deterministic **drill harness**
proving the conflict/loss/reconciliation protocol, and — as of this sprint — the
**browser drill** proving the organizer scan UI + durable queue client round-trip
(M13 below). Offline gate activation remains **NO-GO** — by policy — until the
two-browser conflict/loss drills and a recorded admin decision also exist.
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

**Still required before GO:** the two-device conflict / device-loss / deployment-
during-event drills executed through _two_ real browsers (the single-browser drill
above does not exercise cross-device conflict), and the **recorded admin
activation**. Until both exist, `GET /checkin/activation` stays NO_GO.

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

| Item                                                                                         | Status                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Offline check-in **protocol** (validator, reconciliation, manifest, deltas, activation gate) | ✅ shipped + tested                                                    |
| Service-level drills (conflict / loss / reconciliation / flapping)                           | ✅ PASS                                                                |
| Storage eviction (customer)                                                                  | ✅ shipped (Sprint 8)                                                  |
| Organizer offline **scan UI + durable queue** (single-browser round-trip)                    | ✅ shipped + browser drill PASS → **CONDITIONAL_GO**                   |
| Offline gate **activation**                                                                  | ⛔ **NO-GO** — needs two-browser conflict/loss drills + admin decision |
| Native wallet passes                                                                         | ⛔ **NO-GO** — needs real Apple/Google issuer credentials              |

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
8. Execute + record the **two-browser conflict/loss drills**, then flip activation
   per policy. _(The single-browser client round-trip is now PASS — M13 above.)_

## Recommendation

The protocol, its gate, and now the **organizer offline scan UI + durable queue**
are proven — the single-browser client round-trip passes end-to-end (M13), moving
that leg to CONDITIONAL_GO. The remaining steps before a real-event GO are narrow
and operational, not architectural: (a) the two-browser conflict/loss/deployment
drills, (b) the reconciliation console + command center for gate visibility, and
(c) the recorded org/event/device admin activation. Do not enable offline gate mode
at a real event until (a) and (c) are complete; `GET /checkin/activation` remains
the enforced source of truth and still returns NO_GO.
