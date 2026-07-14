# ETicketsGo — Pilot Support Playbook

First-line support runbook for the pilot. Builds on the reference
[SUPPORT-HANDBOOK](../reports/SUPPORT-HANDBOOK.md) — read that first; this doc adds
the pilot-specific workflow, SLAs, and escalation hooks.

---

## 1. Triage tools

- **Correlation IDs.** Every API error envelope is
  `{ code, message, details, correlationId }`. Ask the customer for (or reproduce
  to obtain) the `correlationId` and search the structured JSON logs by it — it's
  the fastest path from symptom to the exact request.
- **Admin portal** (admin-web `/admin/*`):
  - `/admin/bookings` + `/admin/bookings/[id]` — booking + payment state
  - `/admin/payments` — payment status / provider ref
  - `/admin/refunds` — refund requests and their status
  - `/admin/users` — a user's roles (most "can't do X" tickets are role scope)
  - `/admin/audit` — who did what, when
  - `/admin/ops` — system/queue health during incidents
- **Support inbox** — `/admin/support`. All feedback-widget and help-form
  submissions land here. Kinds: `CONTACT`, `BUG`, `FEATURE`, `GENERAL`, `CSAT`,
  `ORGANIZER_CSAT`. Move each item `OPEN → TRIAGED → CLOSED`
  (`PATCH /api/admin/support/:id`).
- **Health/metrics** — `/api/health`, `/api/ready`, `/api/metrics`.

## 2. Common issues → resolutions

| Symptom                                        | Likely cause                                                        | Resolution                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Payment pending / stuck"                      | Provider webhook delayed, or the 10-min hold expired before pay     | Check booking in `/admin/bookings`. If not confirmed and the hold expired, the seats auto-released — ask them to rebook. If paid at the provider but not confirmed, search by `correlationId` and check the webhook path; escalate if money moved without confirmation. |
| "Charged but no ticket"                        | Provider captured money but confirm didn't complete                 | The confirm guard prevents zero-ticket confirms. Verify in `/admin/payments` + provider. If truly charged, issue a **refund** via `/admin/refunds` and reconcile. Treat money-integrity cases as **SEV1** ([INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md)).                |
| "Seat shows taken but I didn't book it"        | Another buyer holds it (10-minute hold)                             | The hold auto-expires; the seat returns to available. Ask them to retry shortly.                                                                                                                                                                                        |
| "Refund not eligible"                          | Inside the 48h window, wrong booking status, or already covered     | Explain the rule: refundable only while `CONFIRMED`/`PARTIALLY_REFUNDED` and **>48h before** the session. Confirm no open refund already covers the tickets.                                                                                                            |
| "I can't see my revenue / payouts" (organizer) | Role is CHECKIN_STAFF or MANAGER                                    | Financial reads and refund approval are **owner-scoped**. Confirm the role in `/admin/users`; escalate to the org owner to grant access or act.                                                                                                                         |
| "Login keeps failing then blocks me"           | Auth rate limit                                                     | Wait a minute and retry. If it's not the user, check logs for credential-stuffing.                                                                                                                                                                                      |
| "My QR won't scan at the gate"                 | Wrong session, duplicate, invalid/tampered, or staff device offline | Map to the check-in result state ([CHECKIN-GUIDE](./CHECKIN-GUIDE.md)). If staff device is offline, scans fail until it reconnects (no offline queue).                                                                                                                  |
| "No SMS/WhatsApp received"                     | Those channels are **not active** in the pilot                      | Explain: only **email** and in-app are active; phone/push recipient plumbing is pending. Confirm the email instead.                                                                                                                                                     |
| "Movie/event not available"                    | Not published, or the session is in the past                        | Check event/show status in `/admin/events` (or ask the organizer). Only `PUBLISHED` experiences are bookable.                                                                                                                                                           |

## 3. What support can and can't do

**Can:**

- Look up bookings, payments, refunds, users, and audit entries in `/admin/*`.
- Explain eligibility (refund window, holds, roles) and reproduce issues.
- Update support-inbox item status and route to the right owner.
- Trigger a **refund** decision only if you hold an admin role (otherwise route to
  an admin/owner).

**Can't (route these):**

- Approve payouts or refunds without the right role → platform **admin** / org
  **owner**.
- Toggle feature flags at runtime — flags are **env-based at boot**, not runtime.
  A change needs a deploy (engineering).
- Reverse a check-in — that's an organizer **owner/manager** action.
- Move money at the provider directly — reconcile via the provider dashboard
  (engineering/finance).

## 4. Suggested SLAs (pilot)

These are targets to agree with the pilot cohort, not contractual.

| Priority                                     | First response | Resolution target           |
| -------------------------------------------- | -------------- | --------------------------- |
| P1 — money integrity / can't buy / gate down | 15 min         | Mitigate ASAP; ties to SEV1 |
| P2 — degraded (slow, partial failures)       | 1 hour         | Same business day           |
| P3 — single-user issue with workaround       | 4 business hrs | 2 business days             |
| P4 — question / feature request              | 1 business day | Backlog / next planning     |

Map priorities to incident severities via the
[ESCALATION-MATRIX](./ESCALATION-MATRIX.md).

## 5. Reproduce & capture for engineering

When escalating a ticket, attach:

1. **correlationId** (from the error envelope) and rough **timestamp** (with
   timezone).
2. **Booking id / event id / user email** as applicable.
3. **Exact steps** and what you expected vs saw (screenshots welcome).
4. Which **app** (customer/organizer/admin) and route.
5. The **result/state** shown (e.g. refund "not eligible", check-in
   `WRONG_SESSION`, HTTP status).
6. Whether it's **reproducible** and how often.

Hand off to engineering per the [ESCALATION-MATRIX](./ESCALATION-MATRIX.md); if
it's an outage or money-integrity issue, open an incident with
[INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md).
