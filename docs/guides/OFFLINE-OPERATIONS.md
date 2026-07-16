# Offline Gate Operations — Organizer Scan UI & Durable Queue (ADR-035)

This sprint shipped the **operator-facing** half of offline gate check-in: the
organizer offline scan panel and a durable client queue, plus a browser-level drill
proving the client round-trip end-to-end. It builds on the flag-off protocol
foundation ([OFFLINE-CHECKIN.md](OFFLINE-CHECKIN.md)) and its launch gate
([LIVE-DRILLS.md](LIVE-DRILLS.md)) without changing either.

> **Sprint 12 status.** The pilot operations suite is complete: certification →
> controlled activation → reconciliation console → command center → device lifecycle →
> preflight checklist → **queue resilience (retry/backoff/dead-letter + multi-tab
> leader)** → **wallet-pass sandbox** ([WALLET-PASSES.md](WALLET-PASSES.md)).
> `OFFLINE_CHECKIN_ENABLED` remains **disabled by default** (endpoints 404; activation
> NO_GO), and wallet providers are **unavailable** unless explicitly configured.

> **Sprint 13 status.** Controlled-pilot readiness shipped: a pilot **runbook**
> ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)) with explicit GO/NO-GO gates, an **evidence
> package** template ([PILOT-EVIDENCE.md](PILOT-EVIDENCE.md)) over existing audit/ops
> data, a **readiness review** ([PILOT-READINESS.md](PILOT-READINESS.md)) with two small
> panel fixes (IndexedDB-unavailable warning; dead-letter export fallback), and an
> **isolated pilot fixture** (`npm run db:pilot`) driving an end-to-end simulation
> (`offline-pilot-simulation.spec.ts`) that never competes with the shared seed pool.

> **Running the flag-on drills.** Each offline drill is flag-gated (skipped in the
> default suite) and self-discovers a seeded ticket, which it then consumes (checks
> in). They are therefore **isolation-scoped**: run them individually, or reseed
> (`npm run db:seed`) between them, against an API started with
> `OFFLINE_CHECKIN_ENABLED=true`. The default **flag-off** Playwright suite is the
> authoritative CI gate — every offline drill skips there and the core Booking /
> Inventory / Payments / QR / Sharing / Online-check-in / Customer-wallet specs pass.

**Still gated.** Offline gate check-in stays **disabled by default** and
activation is still **NO-GO**. Everything here renders and functions only where the
`OFFLINE_CHECKIN_ENABLED` flag is on; with it off, the panel does not render and the
operational endpoints return 404. The server remains the entry authority — offline
mode never grants final admission, it only queues a scan for reconciliation.

## What shipped

### Organizer Offline Mode panel — `apps/organizer-web/components/offline-checkin.tsx`

Rendered on the event check-in page only when offline readiness reports the flag on
(`offlineReadiness.checks[key=flag].passed`). Flow:

1. **Register + approve device** — self-registers this browser as a gate device
   (org/event-scoped) and approves it. The approved `deviceId` is persisted to
   `localStorage` (`etg_checkin_device_${eventId}`) so an offline queue can still
   sync after a reload. _(Full device lifecycle — suspend/revoke/report-lost — is
   still a documented follow-up; this ships self-register + approve only.)_
2. **Download manifest** — fetches the signed manifest for the selected session and
   caches it to IndexedDB (`saveManifest`). The manifest is the offline root of
   trust; the device holds no QR signing secret.
3. **Validate (offline scan)** — decodes the pasted QR token (`decodeQr`, no
   signature verification — that is the manifest's job) and runs the pure
   `validateOfflineScan` against the cached manifest + the local duplicate ledger.
   Only `VALID` is enqueued; every other of the 15 result states is surfaced and
   **never** queued as a check-in. Results are shown as **text + icon**, never
   colour-only (accessibility).
4. **Sync now** — maps PENDING/SYNCING records to the server `QueuedCheckIn` shape
   and calls `offlineCheckin.reconcile(deviceId, payload)`. The server classifies
   each (`ACCEPTED` / `DUPLICATE_*` / `SUPERVISOR_REVIEW_REQUIRED` / conflict); the
   local record is updated and only **acknowledged** records (ACCEPTED/DUPLICATE)
   are cleared. The server always wins.

Manual token entry is used for the drill and camera-less gates; the camera path
reuses the existing online scanner. The panel shows a live queue count
(`N queued · M conflicts`) and the most recent records with their status.

### Durable client queue — `apps/organizer-web/lib/offline/checkin-queue.ts`

IndexedDB-backed (DB `etg-checkin`, stores `queue` + `manifest`) so accepted offline
scans survive refresh/restart and are **never lost**. Key guarantees:

- **States:** `PENDING → SYNCING → ACCEPTED | DUPLICATE | CONFLICT | REVIEW_REQUIRED | REJECTED`.
- **Local duplicate ledger** (`localCheckedIn`) — a second scan of the same ticket
  on this device returns `ALREADY_CHECKED_IN_LOCAL` and is not re-queued.
- **Idempotency key** per record (`deviceId:ticketId:nonce`) so re-submits collapse
  to a server `DUPLICATE_SAME_DEVICE`, never a double check-in.
- **Never delete before server ack** — `clearAcknowledged` removes only
  ACCEPTED/DUPLICATE; conflicts and review-required rows stay for follow-up.
- **Ordered sync** — pending records replay in scan order (`scannedAt`).

Pure validation + reconciliation logic stays in `@eticketsgo/shared-types`; this
module is only durable transport + the local ledger. _(Multi-tab lock and
exponential backoff / dead-letter are still pending — see LIVE-DRILLS §Remaining.)_

### web-kit API client — `packages/web-kit/src/api.ts`

The `offlineCheckin` group wraps the operational endpoints: `registerDevice`,
`approveDevice`, `revokeDevice`, `listDevices`, `manifest`, `deltas`, `reconcile`,
`offlineReadiness`, `activation`. All 404 when the flag is off; readiness/activation
answer `NO_GO` when off. The API package never imports web-kit (it would pull in
React); shared logic is imported from shared-types on both sides.

## Browser drill — proof, and what it does not yet prove

`apps/e2e/tests/offline-gate-drill.spec.ts` drives the real panel through Chromium
against a flag-on API. It self-discovers a seeded session with an active ticket and
`test.skip`s when the flag is off, so the default (flag-off) suite is unaffected.

**Proven (PASS):** register + approve device → download manifest → offline validate
(`VALID`, queued) → same token again (`ALREADY CHECKED IN LOCAL`, not re-queued) →
**full page reload with the queue intact** → `Sync now` → server `ACCEPTED` → queue
drains. This is the single-browser **client round-trip**, moving that leg from
NO-GO to **CONDITIONAL_GO**.

**Remaining (operational, not gate logic):**

- **Deployment-during-event** drill (operational hardening, not an activation-gate
  input).
- The reconciliation console + Live Event Command Center for day-of visibility.

### Two-browser conflict drill + evidence store (Sprint 11, M14)

`apps/e2e/tests/offline-gate-two-browser.spec.ts` drives **two independent
browsers** — separate devices, separate IndexedDB — that both scan the same ticket
offline and queue it, then reconnect and sync **concurrently**, racing the atomic
`ACTIVE→CHECKED_IN` claim. Proven (PASS): **exactly one `ACCEPTED`**, the other
`DUPLICATE_OTHER_DEVICE` — no double check-in. This exercises both the classify path
and the atomic-claim path in [offline-reconciliation.service.ts](../../apps/api/src/checkins/offline/offline-reconciliation.service.ts).

Drill results are now **persisted and drive the gate**. On PASS the drill records an
`OfflineDrillRun` via `POST /checkin/drills` (manager-only, flag-gated). The
activation gate reads this evidence **fail-closed** — `deriveActivationVerdict`
treats a drill check as passed only when its latest run is a `PASS` within
`DRILL_EVIDENCE_TTL_MS` (90 days). A drill never run, last-failed, or stale keeps the
gate closed. This replaced the previously hardcoded `false` drill inputs; after M14
the `drill_two_device` check is green while `drill_device_loss` / `drill_reconcile`
remain fail-closed, so `GET /checkin/activation` is still `NO_GO`. `GET /checkin/drills`
lists recorded results for a future reconciliation console / command center.

### Device-loss drill (Sprint 11, M15)

`apps/e2e/tests/offline-gate-device-loss.spec.ts` drives the real panel: a device
queues an offline scan, is **REVOKED** while the scan is still queued, then
reconnects. Proven (PASS): the reconcile call returns **403** (a revoked device's
whole queue is rejected — fail-closed), the queued scan is **not** silently dropped,
and server truth confirms the ticket was **never admitted** (`ACTIVE` + eligible).
On PASS it records `DEVICE_LOSS` evidence, flipping `drill_device_loss` green. After
M15 two of the three activation-gate drills are evidence-backed; `drill_reconcile`
is still fail-closed and admin activation is unrecorded, so the gate remains `NO_GO`.

### Reconciliation drill (Sprint 11, M16)

`apps/e2e/tests/offline-gate-reconciliation.spec.ts` proves **the server always wins
and no invalid admission is ever accepted**. The panel drives the valid
offline→queue→sync→`ACCEPTED` round-trip; then a deterministic divergence matrix is
replayed through the real `POST /checkin/reconcile` using the panel's approved
device: wrong-session → `WRONG_SESSION`, rotated nonce → `TRANSFERRED_AFTER_DOWNLOAD`,
vanished ticket → `SUPERVISOR_REVIEW_REQUIRED` (none accepted, ticket stays `ACTIVE`),
a correct scan → `ACCEPTED` exactly once, a replay → `DUPLICATE_SAME_DEVICE`
(idempotent). Repeated inputs yield identical outcomes (deterministic) and every
reconcile is recorded in the admin audit log (`OFFLINE_CHECKIN_RECONCILED`). On PASS
it records `RECONCILIATION` evidence, flipping `drill_reconcile` green. After M16
**all three** activation-gate drills are evidence-backed; the gate remains `NO_GO`
only on the unrecorded admin activation.

### Controlled activation workflow (Sprint 11, M17)

The final blocking gate is a real, scoped, audited decision — never a bare flag flip.
`OfflineActivationService` owns the **single source of truth** for the gate's inputs
(`computeInputs`), used by both `GET /checkin/activation` and the activate pre-check.

- `POST /checkin/activation/record` (manager/admin-only, flag-gated) scopes the
  decision to one org/event/session + explicit ACTIVE devices, only succeeds when
  recording it would make the gate GO (all other blocking readiness + drill checks
  green + current), stores an **immutable evidence snapshot**, supersedes any prior
  ACTIVE decision for the scope, and audits `OFFLINE_ACTIVATION_RECORDED`.
- `POST /checkin/activation/:id/revoke` sets `REVOKED` (who/when/why, audited); the
  scope returns to NO_GO immediately.
- `GET /checkin/activation/decisions` lists recorded decisions.
- **mustDowngrade stays authoritative:** a live decision is ignored the moment a
  scoped device is revoked or the manifest expires — the scope downgrades to NO_GO.

The drill `apps/e2e/tests/offline-gate-activation.spec.ts` proves the lifecycle end
to end: NO_GO before approval → 403 for a non-manager → 400 for an unknown/unapproved
device → recorded `ACTIVE` with a snapshot → **GO for the approved scope** → NO_GO
for any other scope → revoke → NO_GO, with every decision in the admin audit log.

**Net:** `GET /checkin/activation` returns **GO only for a certified, admin-approved,
non-downgraded scope**; everything else is NO_GO. `OFFLINE_CHECKIN_ENABLED` stays
disabled by default — a pilot enables the flag for its deployment, then a manager
records the scoped activation.

> **Test note.** The offline drills authenticate once via the API and seed the
> browser session (`seedBrowserAuth`) rather than logging in through the form a
> second time, keeping the four-drill flag-on run under the auth login throttle
> (10/min) without weakening it.

## Running the drill locally

```bash
# API with the flag on, on :4000
OFFLINE_CHECKIN_ENABLED=true node apps/api/dist/main.js
# organizer-web on :3001, customer-web on :3000 (next start)
# then, from apps/e2e:
npx playwright test offline-gate-drill --reporter=list
```

With the flag **off** (production/CI default) the same command reports the drill as
skipped, and the full suite stays green (`9 passed, 1 skipped`).

## Reconciliation Console (Sprint 12, Priority 1)

The offline operations console for a controlled live pilot. It reads a **durable
reconciliation ledger** and lets a supervisor safely resolve review cases — the
server always wins and the console can **never** convert an invalid admission into
ACCEPTED.

### Durable ledger

The reconcile engine now writes an `OfflineReconciliationRecord` for **every** queued
item it processes (additive; the reconciliation logic, atomic claim, and outcomes are
unchanged). Each record carries the org/event/session, device, operator, **local scan
time** (`localScannedAt`) and **server reconcile time** (`reconciledAt`), the outcome,
`wasOverride`, and a `reviewState` (`NOT_REQUIRED` / `PENDING` / `RESOLVED`). The
outcome is **immutable**; only supervisor resolution may annotate it. Each reconcile
is audited (`OFFLINE_CHECKIN_RECONCILED`, entity `OfflineReconciliationRecord`).

### API (flag-gated, 404 when off)

- `GET /checkin/reconciliation` — staff read; filters by event, session, **device,
  outcome, review status, ticket reference, and time range**; `reconciledAt desc`;
  pagination with a **hard `pageSize` cap of 100** (default 25). Operator/resolver
  emails resolved in one batched query.
- `POST /checkin/reconciliation/:id/resolve` — **manager/admin-only**, requires an
  `action` + a **reason**, fully audited (`OFFLINE_RECONCILIATION_RESOLVED`).

### Console UI

`organizer-web` route `…/events/[id]/reconciliation` (a tab shown **only** when the
offline flag is on). Filters, a paginated table, and a resolve dialog. Every outcome
is shown as **icon + text + badge** (never colour alone). Loading / empty / error
states come from `DataTable`; a "last updated" line + Refresh surface stale data.

### Manual-resolution safeguards (defence in depth)

- **Pure rule** `allowedReconcileResolutions(outcome, reviewState)` returns actions
  **only** for a still-`PENDING` supervisor-review case, and only the audit-only
  `ACKNOWLEDGED` / `DISMISSED` — there is **no ACCEPT/admit action anywhere**.
- The API re-checks the same rule (`canResolveReconcile`); a non-review or
  already-resolved record → **409**; a missing reason → **400**.
- Resolution updates only `reviewState`/annotation fields — the **outcome is never
  changed** and no check-in is ever created here.
- Manager/admin authorization + an audit record on every manual action.

### Verification

Unit tests cover the presentation + resolution rules (only ACCEPTED is an admission;
only a pending review case is resolvable) and the service (invalid transitions,
pagination caps). The drill `apps/e2e/tests/offline-reconciliation-console.spec.ts`
seeds a record of every category through the real reconcile engine, drives the
console UI (filter + resolve), and asserts the safeguards: a **customer cannot view
(403) or resolve (403)**, a **non-review record cannot be resolved (409)**, and the
resolution is **audited**. Skips when the flag is off.

## Live Event Command Center (Sprint 12, Priority 2)

Read-only event-day operational visibility for a controlled pilot, composed entirely
from **existing** activation / readiness / device / reconciliation / attendance /
audit data — no duplicated operational store, and **no action admits a ticket or
changes the gate**. The server stays authoritative.

### API (flag-gated, 404 when off)

- `GET /checkin/command-center?organizationId&eventSessionId` — **staff read**; a
  single bounded, parallel aggregation (no N+1, capped device list, groupBy for
  reconciliation, bounded latency sample) returning: the **activation verdict +
  blocking/downgrade reasons**; device counts (pending/active/suspended/revoked/
  expired/online/offline) with last-seen + manifest version; attendance (total,
  admitted, remaining, admission rate); reconciliation counts (accepted, duplicates,
  rejected, review, **pending reviews**); sync latency + oldest-unseen device; and
  the derived alerts. Devices are scoped to the session's event; records to the
  session.
- `GET /checkin/command-center/activity` — bounded, **paginated** recent offline
  audit activity (hard `pageSize` cap 100).
- `POST /checkin/command-center/alerts/ack` — **manager/admin-only**, requires a
  reason, audited (`OFFLINE_ALERT_ACKNOWLEDGED`); idempotent per (session, alertKey).

### Alerts (deterministic, deduped, throttled)

`deriveCommandCenterAlerts` (pure, unit-tested) turns the snapshot signals into
severity-ranked alerts, each with a **stable key `TYPE:sessionId`** — so re-evaluating
on every poll yields the **same keys and never duplicates**. Rules: `ACTIVATION_DOWNGRADE`
(critical — a live decision no longer GO / mustDowngrade), `REVOKED_DEVICE_ACTIVITY`
(critical), `NO_ACTIVE_DEVICES` (critical when a decision exists), `STALE_MANIFEST`,
`HIGH_DUPLICATE_RATE` (≥25% over a ≥10 sample), `PENDING_SUPERVISOR_REVIEWS`,
`SYNC_FAILURE`, and `QUEUE_GROWTH` (an active device unseen > 5 min). Only
**acknowledgements** are persisted (`OfflineAlertAck`, unique per session+key);
**acknowledging never suppresses the condition** (it keeps deriving) or changes the
gate — the alert stays visible, marked acknowledged.

### Console UI

`organizer-web` route `…/events/[id]/command-center` (a tab shown only when the flag
is on). A session selector, an alerts panel (severity as **icon + text + badge**,
never colour alone; Acknowledge for managers), the activation verdict + reasons,
attendance/reconciliation/device metric cards, a device list with last-seen + manifest
version, and a **paginated** recent-activity table. **Production-safe polling** (15 s
`refetchInterval`) with a "last updated" line + manual Refresh; loading / empty /
error / permission states are all handled.

### Verification

Unit tests cover the alert derivation (each condition, thresholds, severity ranking,
idempotent keys) and the service (ack requires a reason + manager, activity pagination
caps). The drill `apps/e2e/tests/offline-command-center.spec.ts` seeds real
reconciliation + device data, produces one critical condition, and asserts: the
console loads for the scope, metrics reflect real data, **exactly one alert** is
created, **repeated polling does not duplicate it**, a customer **cannot view (403) or
acknowledge (403)**, a reason is **required (400)**, the alert is **scope-isolated**,
acknowledgement is **audited**, and the **underlying condition remains visible** after
ack. Skips when the flag is off.

## Device Lifecycle Management (Sprint 12)

A complete organizer UI for managing offline devices over the existing device API.

### Backend (genuine gaps filled — required by the workflows)

Three capabilities the enum implied but no endpoint provided were added to
`CheckInDeviceService` + the controller (flag-gated, manager/admin-only, audited):

- **Suspend** — `POST /checkin/devices/:id/suspend` → `SUSPENDED` (reversible via
  approve), audits `CHECKIN_DEVICE_SUSPENDED`. Refuses to suspend a revoked device.
- **Revoke with a reason** — revoke now records the reason in the audit metadata.
- **Report lost** — `POST /checkin/devices/:id/report-lost` → revokes and records a
  **distinct** `CHECKIN_DEVICE_REPORTED_LOST` audit action with the reason.
- The device list query is now bounded (`take: 200`). No other backend change; the
  activation/readiness rules are untouched — a revoked/suspended device downgrades
  its scope via the existing `mustDowngrade`, not a new path.

### Console UI

`organizer-web` route `…/events/[id]/devices` (a **Devices** tab shown only when the
flag is on). A searchable / status-filterable / sortable / **paginated** table with
per-device **status (icon + badge + text, never colour alone)**, assigned
event/session, last-seen, manifest version, and expiration; a **details** dialog; and
a **Register** dialog (creates a pending device). Manager/admin row actions —
**Approve, Suspend, Revoke, Report lost** — each open a **confirmation** dialog;
**Revoke and Report-lost require a reason** (Confirm stays disabled until one is
given). Before a destructive action on a device that is part of an **active
activation**, the dialog shows an **activation-impact** warning (the scope will
downgrade to NO_GO). Non-managers see a read-only view.

### Verification

Unit tests cover the new service methods (suspend/revoke-reason/report-lost audit +
the suspend-revoked guard). The drill `apps/e2e/tests/offline-device-lifecycle.spec.ts`
drives the **full lifecycle through the UI** (register → approve → suspend → resume →
revoke → report-lost), and asserts: the **activation-impact** warning appears, Confirm
is disabled without a reason, revoking an in-scope device **downgrades activation to
NO_GO** (rules enforced, not bypassed), a **customer cannot** suspend/revoke (403),
and every action is **audited**. Skips when the flag is off.

## Offline Preflight Checklist (Sprint 12)

A device-scoped, **advisory** pre-event gate that tells an operator whether a device
is safe to enter offline mode. It **reuses** the command-center snapshot (activation
verdict, manifest freshness, pending reviews, critical alerts) + the device record —
it **never re-derives or overrides** any readiness/activation rule. Read-only; the
server stays authoritative. All behind `OFFLINE_CHECKIN_ENABLED`.

### Checklist items (10)

Blocking (a failure → **NOT_READY**): device approved & active; device in scope;
holds the **latest signed manifest**; manifest not expired; device **clock within
tolerance** (2 min); **activation scope is GO**; **no critical command-center alerts**.
Informational (a failure → **WARNING**): revocation **deltas current** (device synced
within the delta window); **local queue clear**; **no unresolved sync issues**
(pending reviews / sync failures). Every non-pass check carries a plain-language
explanation **and actionable guidance**.

### Readiness aggregation

Pure + unit-tested (`buildPreflightChecks` + `derivePreflightVerdict` in shared-types):
each signal maps to a check with `status` (pass/warn/fail) + `blocking`. The verdict
is **NOT_READY** if any blocking check fails, else **WARNING** if any check is not a
pass, else **READY**. The device runs its own preflight — the browser reports its
held manifest version (from IndexedDB), local queue depth, and clock; the server
supplies the authoritative activation/alert/manifest signals via the command-center
snapshot. `POST /checkin/preflight` (staff read, flag-gated).

### Console UI

`organizer-web` route `…/events/[id]/preflight` (a **Preflight** tab shown only when
the flag is on). Pick a session + device, **Run checks** (re-runnable), and see the
**verdict banner** (READY / WARNING / NOT READY, icon + text + badge), the checks
split into **Blocking** vs **Informational** groups, each with an icon, status label,
explanation and guidance (never colour alone), and a **Print** button for operational
records.

### Verification

Unit tests cover the aggregation (every condition, blocking vs warning, verdict
rollup, unreported-values-as-warnings, guidance present). The drill
`apps/e2e/tests/offline-preflight.spec.ts` asserts every condition via the API
(stale manifest, clock skew, queued items, revoked device, activation downgrade,
customer 403) and drives the UI through **READY → WARNING → NOT_READY**, confirming a
blocking failure surfaces its guidance and that revoking an in-scope device downgrades
activation (rules enforced, not bypassed). Skips when the flag is off.

## Offline Queue Resilience (Sprint 12)

Production-grade resilience for the durable IndexedDB queue, preserving every existing
guarantee: **records are never deleted before a server acknowledgement**, sync stays
**ordered** and **per-record idempotent** (`deviceId:ticketId:nonce`), the **local
duplicate ledger** and **reload durability** are unchanged, and the **server remains
authoritative** — no client action can make a rejected scan `ACCEPTED`.

### Retry, backoff, dead-letter

The pure policy lives in `@eticketsgo/shared-types/offline-queue.ts` (unit-tested):

- **Failure classification** — a sync transport failure is either retryable
  (network / HTTP 5xx / 429) or a **non-retryable** authoritative rejection (HTTP 4xx,
  e.g. a revoked-device 403). `ApiRequestError` now carries the HTTP `status` so the
  queue can classify precisely.
- **Bounded exponential backoff** — `backoffDelayMs` = 5s · 2ⁿ capped at 5 min; up to
  `QUEUE_MAX_RETRIES` (6) attempts, then the record **dead-letters** (`BLOCKED`).
- **Per-record retry metadata** — `retryCount`, `lastAttemptAt`, `nextAttemptAt`,
  `failureCategory`, and a **safe operator-facing `failureMessage`** are persisted on
  each record. `isSyncEligible` re-attempts a `RETRYING` record only after its backoff
  elapses; a background timer drains due retries automatically while online.
- **Dead-letter (`BLOCKED`)** — a record that cannot safely continue retrying is held,
  never dropped and never admitted. Operators see it, can **manually retry** eligible
  records (re-submits for the server to decide — never a local ACCEPT), and can **copy
  a safe JSON diagnostic** (ids + failure only, no secrets).
- **Operator visibility** — the panel shows `N queued · N retrying · N blocked · N
conflicts`, with a dead-letter banner (Retry / Copy diagnostic). Queue health also
  feeds **Preflight** (pending+retrying → queue depth; blocked → unresolved sync
  failures) so a device with a growing/blocked queue warns before going offline.

### Multi-tab coordination

Only **one tab acts as the sync leader** per device, so concurrent tabs never submit
the same queue independently (`sync-coordinator.ts`, progressive enhancement):

1. **Web Locks API** (`navigator.locks`, `ifAvailable`) — the browser auto-releases the
   lock on tab close/crash/refresh, giving free **leader takeover**.
2. **localStorage lease** fallback with stale-lease takeover when Web Locks are absent.
3. If neither exists, sync runs directly — the server's idempotency key remains the
   ultimate guard against a double check-in.

A `BroadcastChannel` notifies follower tabs to refresh their queue view after a leader
sync. Verified by `apps/e2e/tests/offline-queue-resilience.spec.ts`: retryable failure
→ auto-recovery; non-retryable → dead-letter → manual retry; reload durability; a scan
never disappears without an ack; and two tabs sharing one device submit the queue
**exactly once**.

## What is deliberately NOT in this sprint

Documented as a follow-up, not faked as complete: the **wallet-pass sandbox**. None of
the existing Booking Engine, Inventory, Payment, QR signing, ownership/assignment/
sharing, customer offline wallet, or online check-in flows were changed.
