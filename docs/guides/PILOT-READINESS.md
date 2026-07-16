# Controlled Offline Check-in Pilot — Readiness Review (Sprint 13)

A dimension-by-dimension review of whether ETicketsGo is ready to run its first
controlled offline check-in pilot. Each row is **Status** (✅ ready / ⚠️ ready with
operational note / 🔧 fixed this sprint) with the concrete resolution. The review
deliberately stayed narrow: only **genuine, small** readiness fixes were made; no product
scope was added and no security control, readiness rule, activation rule, or
reconciliation rule was weakened.

Related: [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md) · [PILOT-EVIDENCE.md](PILOT-EVIDENCE.md) ·
[OFFLINE-OPERATIONS.md](OFFLINE-OPERATIONS.md) · [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Fixes shipped this sprint

Two small, additive robustness fixes surfaced during the review (organizer offline panel):

1. **🔧 IndexedDB-unavailable warning.** If durable queueing is unavailable (IndexedDB
   disabled / private mode), the panel previously no-oped silently — an offline scan could
   be validated but not persisted. The panel now detects this (`isQueueDurable()`) and
   renders a blocking `role="alert"` warning telling the operator not to rely on offline
   mode. No scan is silently lost. _(additive; no behaviour change where IndexedDB works.)_
2. **🔧 Dead-letter export fallback.** Copying the dead-letter diagnostic used the
   clipboard, which is unavailable in insecure contexts and would falsely report success.
   It now falls back to a file download when the clipboard API is absent.

Both are UI-only, backward-compatible, and change no server behaviour.

---

## Readiness by dimension

| #   | Dimension                   | Status | Resolution / operational note                                                                                                                                                                                                                                                                                                |
| --- | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Environment config**      | ✅     | `.env.example` documents every required var. Pilot API needs `DATABASE_URL`, `QR_SIGNING_SECRET` (or `MANIFEST_SIGNING_SECRET`), `REDIS_URL`.                                                                                                                                                                                |
| 2   | **Feature flags**           | ✅     | `OFFLINE_CHECKIN_ENABLED` **off by default**; set to `true` only on the pilot deployment for the pilot window; verify via `offline-readiness` `flag` check. Wallet providers unavailable unless configured.                                                                                                                  |
| 3   | **DB migrations**           | ✅     | All offline models (device, manifest, activation, drill, reconciliation ledger, alert-ack) are migrated. Run `npm run db:deploy` on the pilot DB; **stop the API first on Windows** (query-engine DLL lock).                                                                                                                 |
| 4   | **Redis / BullMQ**          | ⚠️     | Redis backs booking hold-expiry (worker), **not** offline reconciliation — offline check-in has no Redis dependency and degrades independently. Ensure `REDIS_URL` is reachable for normal sales; a Redis blip does not block gate operation.                                                                                |
| 5   | **Browser / IndexedDB**     | 🔧     | Durable queue uses IndexedDB with a presence guard; the panel now **warns** when it is unavailable (fix #1) instead of silently dropping scans. Use a modern Chromium/Firefox/Safari on the gate devices.                                                                                                                    |
| 6   | **Device clock**            | ✅     | Preflight `clock_skew` is a blocking check against a tolerance; enable automatic time on gate devices. Manifest/activation validity is server-timestamped, so a skewed device cannot extend validity.                                                                                                                        |
| 7   | **TLS / secure context**    | ⚠️     | Serve organizer-web over **HTTPS** (or localhost) so camera, Web Locks (multi-tab sync leader), and clipboard work. Without it: IndexedDB still works, and the sync leader falls back to a localStorage lease + BroadcastChannel — offline still functions, just degraded.                                                   |
| 8   | **Camera / permissions**    | ✅     | Online scanning uses `BarcodeDetector`/`getUserMedia` with a manual-entry fallback; the offline panel uses manual/paste token entry, so a denied camera does not block offline operation.                                                                                                                                    |
| 9   | **Network transitions**     | ✅     | `useOnline` + queue retry/backoff/dead-letter handle offline↔online flapping; access-token expiry mid-gap is handled by transparent refresh on reconnect (§ session expiry).                                                                                                                                                 |
| 10  | **Session expiry**          | ✅     | Access token TTL `900s`, refresh TTL `30d`. A long event or offline gap is covered: on reconnect the API client transparently refreshes using the 30-day refresh token, then retries the reconcile. Operators log in once.                                                                                                   |
| 11  | **Auth throttle**           | ⚠️     | Login is rate-limited (`AUTH_THROTTLE_LIMIT`, default 10/min/IP). Sync uses the bearer token (no re-login), so operation is unaffected. **Note:** if many operators log in within a minute from one venue NAT IP, raise `AUTH_THROTTLE_LIMIT` on the pilot deployment or stagger logins — do **not** lower it in production. |
| 12  | **Manifest lifetime**       | ⚠️     | Signed manifest TTL is **6h**. For events longer than 6h, operators re-download the manifest and re-run preflight periodically; preflight `manifest_fresh` and activation `mustDowngrade` both flag an expired manifest.                                                                                                     |
| 13  | **Logging / observability** | ✅     | Command center (`GET /checkin/command-center`) gives live metrics + severity-ranked alerts; every device/drill/activation/reconciliation/alert action is audited. See [MONITORING.md](MONITORING.md).                                                                                                                        |
| 14  | **Data retention**          | ✅     | Audit log and reconciliation ledger are durable/immutable; drill evidence has a 90-day TTL (`DRILL_EVIDENCE_TTL_MS`) — re-run drills if a pilot is scheduled beyond that window.                                                                                                                                             |
| 15  | **Support access**          | ✅     | Manager/Admin can view devices, drills, activation decisions, reconciliation, command center, and audit; all writes require Manager/Admin + reason.                                                                                                                                                                          |
| 16  | **Rollback safety**         | ✅     | Revoke activation → NO_GO, then unset the flag → endpoints 404. Do this **after** queues drain and reviews resolve; a mid-event flag-off makes device queues fail closed (non-retryable) rather than admit. Rehearsed in the pilot simulation.                                                                               |

Legend: ✅ ready · ⚠️ ready with an operational note · 🔧 fixed this sprint.

---

## Blocking vs. non-blocking

**Blocking for GO** (must be green — enforced by activation + preflight): feature flag on
pilot scope, three current PASS drills, approved in-scope devices, valid + fresh manifest,
device clock in tolerance, healthy audit logging, no critical alerts, activation recorded
for the exact scope.

**Non-blocking operational notes** (mitigated, not gating): Redis independence (#4), HTTPS
for full capability (#7), auth-throttle sizing for mass concurrent login (#11), manifest
re-download for >6h events (#12), drill-evidence TTL for far-future pilots (#14).

## Sign-off

- [ ] All blocking dimensions verified green on the pilot deployment.
- [ ] Operational notes reviewed and mitigations assigned.
- [ ] Runbook ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)) walked; evidence template
      ([PILOT-EVIDENCE.md](PILOT-EVIDENCE.md)) prepared.
- [ ] Rollback rehearsed (activation revoke → NO_GO, flag off → 404).
