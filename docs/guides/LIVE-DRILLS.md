# Offline Gate — Live Drills, Activation Policy & Launch Report (ADR-035)

This document tracks the **launch gate** for offline gate check-in: the strict
activation policy, revocation-delta transport, the deterministic **drill harness**
proving the conflict/loss/reconciliation protocol, the **single-browser drill**
proving the scan UI + durable queue round-trip (M13), the **two-browser conflict
drill** proving exactly-one-ACCEPTED with a persisted evidence store that now drives
the gate (M14), the **device-loss drill** proving a revoked device is fail-closed
(M15), the **reconciliation drill** proving the server always wins and no bad
admission is ever accepted (M16), and the **controlled activation workflow** — the
recorded, scoped, audited admin decision that is the final blocking gate (M17). With
all three drills evidence-backed and a certified scope approved, `GET /checkin/activation`
can now return **GO for that exact scope**; every other scope stays NO-GO, and
activation is always org/event/device-scoped with no global enable.

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

## Controlled activation workflow (M17)

The final blocking gate — `adminActivationRecorded` — is now a real, scoped, audited
decision (`OfflineActivation`), never a bare flag flip. `OfflineActivationService` is
the **single source of truth** for the gate's inputs: `GET /checkin/activation` and
the activate pre-check both read `computeInputs`, so the gate and the workflow can
never disagree.

- **Record** (`POST /checkin/activation/record`, manager/admin-only, flag-gated):
  scopes the decision to one org/event/session + an explicit set of ACTIVE devices,
  requires every named device to be approved/unexpired/event-scoped, and only
  succeeds when recording it would make the gate GO (i.e. every other blocking
  readiness + drill check is already green and current). It stores an **immutable
  evidence snapshot** (the `ActivationInputs` + derived checks + device ids +
  timestamp), supersedes any prior ACTIVE decision for the scope, and audits
  `OFFLINE_ACTIVATION_RECORDED`.
- **Revoke** (`POST /checkin/activation/:id/revoke`): sets `REVOKED`, records who/when/
  why, audits `OFFLINE_ACTIVATION_REVOKED`; the scope returns to NO_GO immediately.
- **mustDowngrade stays authoritative at read time:** a decision only counts while
  its scoped devices are still ACTIVE and the manifest is unexpired — a revoked
  device or expired manifest downgrades the scope to NO_GO even with a live decision.

### Activation drill (M17) — result

`apps/e2e/tests/offline-gate-activation.spec.ts` exercises the real endpoints
end-to-end (skips when the flag is off):

| Assertion                                                                                | Result  |
| ---------------------------------------------------------------------------------------- | ------- |
| Gate is **NO_GO before approval** (all readiness/drill checks green, only admin missing) | ✅ PASS |
| Non-manager (customer) cannot record — **403**                                           | ✅ PASS |
| Unknown device / unapproved device rejected — **400** (scope + missing evidence)         | ✅ PASS |
| Valid scoped approval recorded → `ACTIVE` with an immutable evidence snapshot            | ✅ PASS |
| Gate becomes **GO for the approved scope**                                               | ✅ PASS |
| An **unapproved scope** (org-wide / no session) stays **NO_GO** — never global           | ✅ PASS |
| **Revocation** returns the scope to **NO_GO**                                            | ✅ PASS |
| Decision + revocation recorded in the admin **audit log**                                | ✅ PASS |

Unit tests (`offline-activation.service.spec.ts`) cover the fail-closed eligibility
matrix: no decision → false; healthy ACTIVE decision → true; a scoped device revoked
or manifest expired → `mustDowngrade` → false; record rejects a red drill / an
unapproved device / an empty scope; revoke flips the scope back.

This closes the launch gate: a **certified, admin-approved scope can reach GO**,
while everything uncertified or unapproved stays NO_GO — enforced, audited, revocable.

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

`GET /checkin/activation` reports the current verdict. As of M17 **every** input is
evidence-driven: the three drill checks (fail-closed evidence store) and the
`adminActivationRecorded` check (a scoped `OfflineActivation`, with `mustDowngrade`
applied). For an org/event/session that is fully certified AND has a live, non-
downgraded admin decision it returns **GO**; every other scope returns NO_GO. No
input is hardcoded, and there is no global enable.

## Launch report — GO / NO-GO

| Item                                                                                         | Status                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Offline check-in **protocol** (validator, reconciliation, manifest, deltas, activation gate) | ✅ shipped + tested                                                |
| Service-level drills (conflict / loss / reconciliation / flapping)                           | ✅ PASS                                                            |
| Storage eviction (customer)                                                                  | ✅ shipped (Sprint 8)                                              |
| Organizer offline **scan UI + durable queue** (single-browser round-trip)                    | ✅ shipped + browser drill PASS → **CONDITIONAL_GO**               |
| **Two-browser conflict** drill (exactly one ACCEPTED) + recorded evidence                    | ✅ PASS (M14) — `drill_two_device` green                           |
| **Device-loss** drill (revoked device fail-closed) + recorded evidence                       | ✅ PASS (M15) — `drill_device_loss` green                          |
| **Reconciliation** drill (server wins, no bad admission) + recorded evidence                 | ✅ PASS (M16) — `drill_reconcile` green                            |
| **Controlled activation workflow** (scoped, audited, revocable admin decision)               | ✅ shipped + drill PASS (M17)                                      |
| Offline gate **activation**                                                                  | ✅ **GO achievable** per certified+approved scope; NO_GO otherwise |
| Native wallet passes                                                                         | ⛔ **NO-GO** — needs real Apple/Google issuer credentials          |

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
9. ✅ **Controlled activation workflow** (M17) — the scoped, audited, revocable admin
   decision (`OfflineActivation`) that drives `adminActivationRecorded`. A certified,
   approved scope can now reach GO. This closes the launch gate.

## Recommendation

The launch gate is **closed**: the protocol, the scan UI + durable queue, all three
activation-gate drills, and the **controlled activation workflow** are shipped and
proven. `GET /checkin/activation` now returns **GO only for a fully certified,
admin-approved, non-downgraded scope**, and NO_GO for everything else — enforced,
audited, and revocable, with `mustDowngrade` authoritative at read time.

Remaining before a real pilot is **operational**, not gate logic:
`OFFLINE_CHECKIN_ENABLED` stays disabled by default and must be enabled for the
pilot deployment; a manager/admin then records the scoped activation via
`POST /checkin/activation/record`. The reconciliation console + Live Event Command
Center add day-of visibility on top of this gate. Do not enable offline gate mode at
a real event without a recorded activation for that exact org/event/session scope;
`GET /checkin/activation` remains the enforced source of truth.
