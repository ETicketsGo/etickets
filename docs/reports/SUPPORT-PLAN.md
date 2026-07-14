# ETicketsGo — Production Support Plan

> How ETicketsGo is supported in production: the channels that exist in the
> product, the tiers/SLAs, how issues escalate, a staffing suggestion, and the
> metrics support watches. This plan **operationalises** the pilot playbooks —
> it does not repeat them. Read alongside:
> [Support Handbook](./SUPPORT-HANDBOOK.md) (reference) ·
> [Pilot Support Playbook](../pilot/SUPPORT-PLAYBOOK.md) (first-line workflow) ·
> [Escalation Matrix](../pilot/ESCALATION-MATRIX.md) ·
> [Incident Response](../pilot/INCIDENT-RESPONSE.md) ·
> [Operations](./OPERATIONS.md) · [Monitoring Checklist](./MONITORING-CHECKLIST.md).

---

## 1. Support channels (in the product today)

| Channel                    | Where                                                                                  | Feeds                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **In-app feedback widget** | Customer/organizer apps → `apps/api/src/support`                                       | Submissions land in the support inbox. Kinds: `CONTACT`, `BUG`, `FEATURE`, `GENERAL`. |
| **Support inbox**          | admin-web `/admin/support` (`PATCH /api/admin/support/:id`)                            | Triage queue for all widget + help-form items; states `OPEN → TRIAGED → CLOSED`.      |
| **Surveys (CSAT)**         | Post-experience prompts → inbox kinds `CSAT`, `ORGANIZER_CSAT`                         | Customer + organizer satisfaction signal.                                             |
| **Admin oversight**        | `/admin/bookings`, `/admin/payments`, `/admin/refunds`, `/admin/users`, `/admin/audit` | Look-ups to resolve tickets (booking/payment/refund state, roles, who-did-what).      |
| **Ops console**            | `/admin/ops` (`apps/api/src/ops`)                                                      | System/queue health + **maintenance mode** during incidents.                          |

Triage always starts from the **correlationId** in the API error envelope
(`{ code, message, details, correlationId }`) — search the structured JSON logs by
it to go from symptom to the exact request. Full first-line workflow and the
common-issue → resolution table are in the
[Pilot Support Playbook](../pilot/SUPPORT-PLAYBOOK.md).

---

## 2. Tiers & SLAs

Two-tier support: **L1 first-line** (triage, look-ups, eligibility explanations,
inbox routing) and **L2 engineering** (bugs, incidents, money integrity, deploys).
Priorities map to incident severities via the
[Escalation Matrix §3](../pilot/ESCALATION-MATRIX.md).

| Priority | Definition                                       | First response | Resolution target       | Owner                 |
| -------- | ------------------------------------------------ | -------------- | ----------------------- | --------------------- |
| **P1**   | Money integrity / can't buy / gate down (→ SEV1) | 15 min         | Mitigate ASAP           | On-call eng + Finance |
| **P2**   | Degraded (slow, partial failures)                | 1 hour         | Same business day       | On-call eng           |
| **P3**   | Single-user issue with a workaround              | 4 business hrs | 2 business days         | L1 → eng backlog      |
| **P4**   | Question / feature request                       | 1 business day | Backlog / next planning | L1 → product          |

These are targets to agree with each cohort, not contractual (per the pilot SLA
table). **P1 always pages** — money integrity or an active live event impacted;
everything else is a ticket. See the page-vs-ticket rule in the
[Escalation Matrix §4](../pilot/ESCALATION-MATRIX.md).

### What support can / can't do

L1 can look up bookings/payments/refunds/users/audit, explain eligibility (refund
window, 10-min holds, role scope), update inbox status, and route. L1 **cannot**
approve payouts/refunds without the role, toggle feature flags (env-based at boot →
needs a deploy), reverse a check-in (organizer owner/manager), or move money at the
provider. Full matrix: [Support Playbook §3](../pilot/SUPPORT-PLAYBOOK.md).

---

## 3. Escalation

```
L1 support ──(reproduce + correlationId)──► L2 engineering ──► On-call / Incident
     │                                                              │
     └── policy/role (refund/payout/revenue) ──► Platform Admin / Org Owner
```

- **Standard path** — L1 captures the evidence pack (correlationId + timestamp,
  booking/event/user, exact steps, app+route, result state, reproducibility;
  [Playbook §5](../pilot/SUPPORT-PLAYBOOK.md)) and hands to L2 per the
  [Escalation Matrix](../pilot/ESCALATION-MATRIX.md).
- **Money integrity** — charged-no-ticket, double-charge/refund suspicion →
  **SEV1**, page On-call + Finance. Pull `/admin/bookings|payments|refunds|payouts`
  - `/admin/audit`; **do not** issue manual provider-side corrections without
    Finance + Engineering sign-off (refunds/payouts are single-issue by design). See
    [Escalation Matrix §5](../pilot/ESCALATION-MATRIX.md).
- **Security** — suspected breach / leaked creds / auth abuse → SEV1, Security
  Contact + On-call; preserve logs/audit; consider maintenance mode. See
  [Escalation Matrix §6](../pilot/ESCALATION-MATRIX.md) and
  [Incident Response](../pilot/INCIDENT-RESPONSE.md).

Populate the **roster and on-call rotation** placeholders in the
[Escalation Matrix §1–2](../pilot/ESCALATION-MATRIX.md) before opening the doors —
that table is only useful when filled in.

---

## 4. Staffing suggestion (soft launch)

Sized for a controlled launch; scale with volume.

| Role                 | Coverage                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1 support**       | 1–2 during business hours; shared inbox rota. Owns `/admin/support`.                                                                                                 |
| **On-call engineer** | 1 primary + 1 secondary, weekly (or event-based) rotation. **Live-event coverage:** an engineer on-call for every scheduled event's door-open → doors-closed window. |
| **Platform admin**   | Refund/payout approvals, organizer review, maintenance-mode calls.                                                                                                   |
| **Finance contact**  | On-call for money-integrity reconciliation (SEV1).                                                                                                                   |
| **Security contact** | Reachable for SEV1 security incidents.                                                                                                                               |

Handover, primary/secondary, and live-event coverage detail: fill the
[Escalation Matrix §2](../pilot/ESCALATION-MATRIX.md).

---

## 5. Metrics support watches

Support and on-call watch the same `etg_*` series the on-call dashboard shows
(full catalog + alert rules: [Monitoring Guide](../guides/MONITORING.md),
checklist: [Monitoring Checklist](./MONITORING-CHECKLIST.md)):

- **Money paths** — `etg_payments_failed_total` rate, `etg_bookings_confirmed_total`
  vs `etg_bookings_created_total` (confirm ratio), `etg_refunds_completed_total`,
  `etg_gmv_minor_total`. A payment-failure or confirm-error spike precedes a wave of
  "charged but no ticket" tickets.
- **Gate** — `etg_qr_checkin_success_total` / `etg_qr_checkin_failure_total` (a
  failure spike at an event = a gate issue → page).
- **Health** — `etg_http_requests_total{status_class="5xx"}` (~0 expected; 409s are
  healthy contention, not errors), `etg_http_request_duration_seconds` p95/p99,
  BullMQ `etg_queue_jobs` depth (email/hold-expiry delays).
- **Support signal** — support-inbox open-item count and CSAT/`ORGANIZER_CSAT`
  trend; ticket volume by kind (`BUG`/`FEATURE`/`CONTACT`).

Alerts (`observability/prometheus/alerts.yml`) that most often turn into tickets:
`PaymentsFailureRateHigh`, `BookingConfirmErrorRateHigh`, `HighHttp5xxRate`,
`QueueBacklogHigh`. Route them to Slack/PagerDuty via Alertmanager.
