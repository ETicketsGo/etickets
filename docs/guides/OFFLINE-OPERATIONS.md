# Offline Gate Operations — Organizer Scan UI & Durable Queue (ADR-035)

This sprint shipped the **operator-facing** half of offline gate check-in: the
organizer offline scan panel and a durable client queue, plus a browser-level drill
proving the client round-trip end-to-end. It builds on the flag-off protocol
foundation ([OFFLINE-CHECKIN.md](OFFLINE-CHECKIN.md)) and its launch gate
([LIVE-DRILLS.md](LIVE-DRILLS.md)) without changing either.

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

**Not proven here (still NO-GO for activation):**

- **Two-device conflict / device-loss** across two _real_ browsers — the
  single-browser drill cannot exercise cross-device races. The service-level drills
  cover the protocol; the browser versions are still required.
- **Deployment-during-event** drill.
- The **recorded org/event/device admin activation**. `GET /checkin/activation`
  remains the enforced gate and still returns `NO_GO`.

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

## What is deliberately NOT in this sprint

Documented as follow-ups, not faked as complete: the **reconciliation console** +
supervisor override UI, the **Live Event Command Center** + event-day alerting, the
full **device-management lifecycle** UI, offline **preflight** checklist, queue
**backoff/dead-letter + multi-tab lock**, and the **wallet-pass sandbox**. None of
the existing Booking Engine, Inventory, Payment, QR signing, ownership/assignment/
sharing, customer offline wallet, or online check-in flows were changed.
