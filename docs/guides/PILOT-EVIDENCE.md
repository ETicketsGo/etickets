# Controlled Offline Check-in Pilot — Evidence Package (Sprint 13)

A pilot is only useful if it is **auditable after the fact**. This is the structured
template the pilot lead fills in to certify a pilot run. It deliberately **reuses existing
authoritative data** — the immutable audit log, the activation decisions, the durable
reconciliation ledger, and the command-center snapshot — rather than introducing a second
source of truth. Every field below cites the endpoint/record it comes from, so the package
is a _view_ over real operational data, not a re-entry of it.

Overall verdict at the end is one of **PASS / CONDITIONAL PASS / FAIL**.

Related: [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md) · [PILOT-READINESS.md](PILOT-READINESS.md) ·
[RECONCILIATION-OPERATIONS.md](RECONCILIATION-OPERATIONS.md)

---

## 1. Pilot identity

| Field                                    | Value | Source                          |
| ---------------------------------------- | ----- | ------------------------------- |
| Pilot date / window                      | _…_   | operator record                 |
| Organization ID                          | _…_   | `GET /organizations`            |
| Event / session ID                       | _…_   | `GET /events/:id`               |
| Pilot lead (Manager/Admin)               | _…_   | activation record `decidedBy`   |
| Approved device IDs                      | _…_   | `GET /checkin/devices?eventId=` |
| Feature-flag window (enabled → disabled) | _…_   | deploy log + audit              |

## 2. Certification evidence (pre-activation)

| Field                              | Value                                            | Source                                |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `TWO_DEVICE_CONFLICT` drill        | PASS @ _ts_                                      | `GET /checkin/drills?eventSessionId=` |
| `DEVICE_LOSS` drill                | PASS @ _ts_                                      | `GET /checkin/drills?eventSessionId=` |
| `RECONCILIATION` drill             | PASS @ _ts_                                      | `GET /checkin/drills?eventSessionId=` |
| Preflight (pre-activation) verdict | NOT_READY (activation_go pending, all else pass) | `POST /checkin/preflight`             |

## 3. Activation evidence

| Field                                      | Value                                | Source                                                |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------------------- |
| Activation ID                              | _…_                                  | `POST /checkin/activation/record` → `id`              |
| Scope (org / event / session / device IDs) | _…_                                  | activation record                                     |
| Recorded by / at / reason                  | _…_                                  | activation record + audit `OFFLINE_ACTIVATION_RECORD` |
| Verdict after record                       | GO                                   | `GET /checkin/activation`                             |
| Evidence snapshot captured                 | yes (immutable)                      | activation `evidenceSnapshot`                         |
| Preflight (post-activation) verdict        | READY / WARNING (activation_go pass) | `POST /checkin/preflight`                             |
| Revoked by / at / reason                   | _…_                                  | audit `OFFLINE_ACTIVATION_REVOKE`                     |
| Verdict after revoke                       | NO_GO                                | `GET /checkin/activation`                             |

## 4. Operational evidence (from the command-center snapshot)

Pull a final `GET /checkin/command-center?organizationId=…&eventSessionId=…` snapshot.

| Field                                        | Value          | Source (`snapshot.reconciliation.*` / `.alerts`)                 |
| -------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| Total scans reconciled                       | _…_            | `totalScans`                                                     |
| Accepted                                     | _…_            | `accepted`                                                       |
| Duplicates (same/other device)               | _…_            | derived from reconciliation outcomes                             |
| Already-checked-in-online (server won)       | _…_            | reconciliation outcomes                                          |
| Rejected / fail-closed (e.g. revoked device) | _…_            | reconciliation outcomes + 403s                                   |
| Supervisor reviews raised                    | _…_            | `GET /checkin/reconciliation?outcome=SUPERVISOR_REVIEW_REQUIRED` |
| Supervisor reviews resolved                  | _…_            | resolution audit entries                                         |
| Pending reviews at close                     | **0 expected** | `snapshot.reconciliation.pendingReviews`                         |
| Critical alerts raised                       | _…_            | `snapshot.alerts` where `severity: "critical"`                   |
| Critical alerts explained/acknowledged       | _…_            | `POST /checkin/command-center/alerts/ack` audit                  |

## 5. Integrity assertions (must all hold)

These are the invariants a pilot must not violate. Each is enforced by the server; the
package records that they held.

- [ ] **Server stayed authoritative** — no offline scan granted final admission; the
      server reconciled every scan. _(reconciliation ledger)_
- [ ] **No rejected → ACCEPTED** — no console/resolve action converted a rejected or
      review scan into `ACCEPTED`. _(resolutions are audit-only; reconciliation ledger)_
- [ ] **Revoked device failed closed** — any revoked/lost device's queued scans were
      rejected (403), not admitted. _(reconciliation ledger + audit)_
- [ ] **Duplicates deduped** — one admission per ticket; cross-device dup resolved to a
      single `ACCEPTED`. _(reconciliation ledger)_
- [ ] **Activation was scoped + reversible** — GO limited to the pilot scope; revocation
      returned it to NO_GO. _(activation records)_
- [ ] **Flag returned to off** — offline endpoints 404 after stand-down. _(readiness/deploy)_
- [ ] **Full audit trail present** — device, drill, activation, reconciliation, and
      alert actions all appear in `GET /admin/audit`. _(audit log)_

## 6. Verdict

| Verdict              | Criteria                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**             | All §5 assertions hold; pending reviews 0; activation revoked; flag off; audit complete.                                                                       |
| **CONDITIONAL PASS** | §5 assertions hold, but operational follow-ups remain (e.g. a documented UX friction, a non-blocking alert to investigate). Note them and a remediation owner. |
| **FAIL**             | Any §5 assertion violated — investigate as an incident before any further pilot. A FAIL blocks progression to a broader rollout.                               |

**Recorded verdict:** _PASS / CONDITIONAL PASS / FAIL_
**Notes / follow-ups:** _…_

---

## Reproducing the evidence shape

The automated rehearsal `apps/e2e/tests/offline-pilot-simulation.spec.ts` walks the same
workflow against the isolated pilot fixture and asserts the §5 invariants
programmatically (server-wins on online replay, single `ACCEPTED` on cross-device dup,
403 on revoked-device reconcile, a critical alert on revoked-device activity, review
resolved to `pendingReviews: 0`, activation GO → NO_GO). Its assertions are the executable
form of this package.
