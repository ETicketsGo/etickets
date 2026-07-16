# Controlled Offline Check-in Pilot — Runbook (Sprint 13)

This runbook drives ETicketsGo's **first controlled offline gate check-in pilot**: a
single, small, supervised event where offline mode is deliberately enabled for one
approved scope, operated by trained staff, and switched back off afterward. It composes
the already-shipped building blocks — certification drills, controlled activation,
reconciliation console, command center, device lifecycle, preflight — into one operator
procedure with explicit **GO / NO-GO** gates.

It changes no product behaviour. Every safety rule referenced here is enforced by the
server regardless of this document: the server remains the sole admission authority,
offline mode only queues scans for reconciliation, and a rejected scan can never be
turned into `ACCEPTED` by any console action.

> **Scope discipline.** Pick the smallest viable pilot: one event, one session, a handful
> of approved devices, staff who have run the drills. Do **not** enable the flag globally
> or for multiple events. Activation is per-scope by design — keep it that way.

Related: [OFFLINE-CHECKIN.md](OFFLINE-CHECKIN.md) · [OFFLINE-OPERATIONS.md](OFFLINE-OPERATIONS.md) ·
[LIVE-DRILLS.md](LIVE-DRILLS.md) · [RECONCILIATION-OPERATIONS.md](RECONCILIATION-OPERATIONS.md) ·
[PILOT-READINESS.md](PILOT-READINESS.md) · [PILOT-EVIDENCE.md](PILOT-EVIDENCE.md)

All API paths below are under the base `/api`. Manager/Admin role is required for every
device, drill, activation, reconciliation, and command-center write.

---

## 0. Roles

| Role                                          | Responsibility                                                      |
| --------------------------------------------- | ------------------------------------------------------------------- |
| **Pilot lead** (Manager/Admin)                | Owns GO/NO-GO, records + revokes activation, resolves reviews.      |
| **Gate operators**                            | Run the offline panel on approved devices; scan; sync on reconnect. |
| **Reconciliation supervisor** (Manager/Admin) | Watches the console + command center; triages reviews.              |

---

## 1. Pre-pilot preparation (T-minus days)

1. **Confirm environment readiness** — walk [PILOT-READINESS.md](PILOT-READINESS.md)
   end to end. Every blocking row must be green before proceeding.
2. **Train operators** on the offline panel: register/approve, download manifest, scan,
   read the queue counters (`queued · retrying · blocked · conflicts`), Sync now, and
   the dead-letter banner.
3. **Run the certification drills** for the pilot session and record each PASS:
   - `POST /checkin/drills` with `drillKey` ∈ `TWO_DEVICE_CONFLICT`, `DEVICE_LOSS`,
     `RECONCILIATION` (see [LIVE-DRILLS.md](LIVE-DRILLS.md)).
   - Verify: `GET /checkin/drills?eventSessionId=…` shows three current PASS records.
4. **Approve exactly the pilot devices**:
   - `POST /checkin/devices` → `POST /checkin/devices/:id/approve` for each.
   - Verify: `GET /checkin/devices?eventId=…` lists only the intended, approved devices.

**GO/NO-GO — Preparation gate**

- ✅ GO when: all three drills PASS and current; only intended devices approved; operators trained.
- ⛔ NO-GO if: any drill missing/failed/stale, or any unexpected/unapproved device in scope.

---

## 2. Enable the feature flag (T-minus hours, controlled window)

`OFFLINE_CHECKIN_ENABLED` is **off by default** and must stay off outside the pilot window.

1. Set `OFFLINE_CHECKIN_ENABLED=true` **only** on the pilot API deployment; restart the API.
2. Verify the flag is live: `GET /checkin/offline-readiness?organizationId=…` → the `flag`
   check `passed: true`. (With the flag off, the offline endpoints return 404.)
3. Leave activation **NO_GO** for now — the flag alone grants nothing.

**GO/NO-GO — Flag gate**

- ✅ GO when: `flag` check passes on the pilot deployment **only**, and activation is still NO_GO.
- ⛔ NO-GO if: the flag is set anywhere beyond the pilot scope.

---

## 3. Device preflight (T-minus minutes, at the gate)

For each approved device, on the actual device/browser it will use:

1. Open the offline panel (`/organizer/events/:id/checkin`), select the pilot session.
2. **Download manifest** — confirms a fresh signed manifest is cached (`manifest-status`).
3. Run **preflight**: `POST /checkin/preflight` with `deviceId`, the device's
   `clientManifestVersion`, `clientTimeMs`, and `queueDepth`.
   - Advisory only. It **never** overrides readiness/activation. Expect `NOT_READY` here
     because activation is not yet recorded (`activation_go` fails by design) — that is
     the correct pre-activation state. Every _other_ blocking check should already pass:
     `device_active`, `device_scope`, `manifest_latest`, `manifest_fresh`, `clock_skew`,
     `audit`/`no_blocking_alerts`.
4. Resolve any non-activation blocking failure before continuing (clock skew → fix device
   clock; stale/behind manifest → re-download).

**GO/NO-GO — Device gate**

- ✅ GO when: every device shows all non-`activation_go` blocking checks passing.
- ⛔ NO-GO for any device failing `device_active`, `manifest_latest`, `manifest_fresh`, or `clock_skew`.

---

## 4. Record controlled activation → GO (event start)

1. Pilot lead records the scoped activation:
   - `POST /checkin/activation/record` with `organizationId`, `eventSessionId`,
     `deviceIds` (the approved pilot devices), and a `reason`.
   - The server re-checks the full gate and **refuses** if any blocking readiness/drill
     evidence is missing, failed, or stale, or if the scope is too broad / includes an
     unapproved device. It snapshots the evidence immutably.
2. Confirm GO: `GET /checkin/activation?organizationId=…&eventSessionId=…` → `verdict: "GO"`.
3. Re-run device preflight (§3.3) — `activation_go` now passes; verdict should be
   `READY` (or `WARNING` only for non-blocking advisories such as a recent-sync notice).

**GO/NO-GO — Activation gate (the real pilot start)**

- ✅ GO when: `GET /checkin/activation` returns `GO` for the exact pilot scope.
- ⛔ NO-GO if: activation is refused, or returns `NO_GO`/`CONDITIONAL_GO`. **Do not operate offline.**

---

## 5. Operate the gate

- Operators scan on approved devices. Online-first: when connectivity exists, scans check
  in normally. When offline, each scan validates against the cached signed manifest and
  **queues durably**; the counter shows `N queued`.
- On reconnect, **Sync now** reconciles the queue. Outcomes: `ACCEPTED`, `DUPLICATE_*`
  (same person scanned twice / two devices), `ALREADY_CHECKED_IN_ONLINE` (server already
  admitted — server wins), or `SUPERVISOR_REVIEW_REQUIRED`.
- The supervisor watches `GET /checkin/command-center?…` (metrics + severity-ranked
  alerts) and the reconciliation console (`GET /checkin/reconciliation?…`).

**Standing rules during operation (server-enforced):**

- A **rejected** scan is never admitted by any console action. Review resolutions
  (`ACKNOWLEDGED` / `DISMISSED`) are **audit-only** and never flip an outcome to `ACCEPTED`.
- If a device is lost/compromised, **revoke it immediately**
  (`POST /checkin/devices/:id/revoke` with a reason). Its queued scans then fail closed
  (reconcile → 403) and a **critical** command-center alert is raised.
- For events longer than the 6-hour manifest TTL, operators re-download the manifest and
  re-run preflight periodically (preflight/activation flag an expired manifest).

**GO/NO-GO — Continue/abort during operation**

- ▶️ Continue while: alerts are triaged, reviews stay bounded, no unexplained rejections.
- ⛔ Abort to online-only if: a critical alert cannot be explained, activation downgrades
  to NO_GO, or reconciliation backlog grows faster than it is resolved. Aborting is safe —
  the server was always authoritative.

---

## 6. Reconciliation & review resolution

1. Triage each `SUPERVISOR_REVIEW_REQUIRED` case in the console.
2. Resolve audit-only: `POST /checkin/reconciliation/:id/resolve` with
   `action: "ACKNOWLEDGED" | "DISMISSED"` and a `reason`. This records the supervisor's
   decision; it does **not** admit the ticket.
3. At close, confirm `GET /checkin/command-center` shows `pendingReviews: 0`.

---

## 7. Stand down → revoke activation → disable flag (rollback)

1. **Revoke activation**: `POST /checkin/activation/:id/revoke` with a reason.
   - Verify: `GET /checkin/activation` → `verdict: "NO_GO"`.
2. Ensure all device queues are synced (`0 queued`) and reviews resolved.
3. **Disable the flag**: unset `OFFLINE_CHECKIN_ENABLED` (back to default); restart the API.
   - Verify: offline endpoints return 404; activation is NO_GO.
4. Assemble the evidence package ([PILOT-EVIDENCE.md](PILOT-EVIDENCE.md)).

**GO/NO-GO — Stand-down gate**

- ✅ Complete when: activation NO_GO, flag off, queues drained, reviews resolved, evidence captured.

---

## Quick reference — endpoints

| Step                           | Method + path                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Readiness / flag               | `GET /checkin/offline-readiness?organizationId=`                                                        |
| Register / approve device      | `POST /checkin/devices` · `POST /checkin/devices/:id/approve`                                           |
| Suspend / revoke / report-lost | `POST /checkin/devices/:id/{suspend,revoke,report-lost}`                                                |
| Manifest                       | `GET /checkin/manifest?eventSessionId=`                                                                 |
| Drills                         | `POST /checkin/drills` · `GET /checkin/drills?eventSessionId=`                                          |
| Preflight                      | `POST /checkin/preflight`                                                                               |
| Activation                     | `GET /checkin/activation?…` · `POST /checkin/activation/record` · `POST /checkin/activation/:id/revoke` |
| Reconcile (device)             | `POST /checkin/reconcile`                                                                               |
| Reconciliation console         | `GET /checkin/reconciliation?…` · `POST /checkin/reconciliation/:id/resolve`                            |
| Command center                 | `GET /checkin/command-center?…` · `POST /checkin/command-center/alerts/ack`                             |
| Audit trail                    | `GET /admin/audit?…`                                                                                    |

## Automated rehearsal

The end-to-end pilot workflow is exercised by the flag-on drill
`apps/e2e/tests/offline-pilot-simulation.spec.ts` against an **isolated pilot fixture**
(`npm run db:pilot` — a dedicated event + ticket pool that never competes with the shared
seed). Run it as a dry run before a real pilot; see [PILOT-EVIDENCE.md](PILOT-EVIDENCE.md).
