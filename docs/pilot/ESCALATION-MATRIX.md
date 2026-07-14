# ETicketsGo — Pilot Escalation Matrix

Who owns what, how to reach them, and how fast. Use with the
[INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md) flow and the
[SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

> Fill in the **names and contact channels** in the placeholders below before the
> pilot starts — this table is only useful when it's populated.

---

## 1. Roster (placeholders — fill in)

| Role               | Person | Primary contact          | Backup |
| ------------------ | ------ | ------------------------ | ------ |
| Program Owner      | _TBD_  | _channel / phone_        | _TBD_  |
| On-call Engineer   | _TBD_  | _pager / phone_          | _TBD_  |
| Platform Admin     | _TBD_  | _channel_                | _TBD_  |
| First-line Support | _TBD_  | _shared inbox / channel_ | _TBD_  |
| Payments/Finance   | _TBD_  | _channel_                | _TBD_  |
| Security Contact   | _TBD_  | _channel / email_        | _TBD_  |

## 2. On-call rotation (placeholder)

- Rotation: _weekly / event-based — define here._
- Primary on-call: _TBD_ · Secondary: _TBD_.
- Handover: _time + method._
- Live-event coverage: for any scheduled live event, an engineer is on-call for
  the door-open → doors-closed window.

## 3. Issue × severity → owner → contact → response target

| Issue type                                                          | Severity | Owner / team                  | Contact method           | First response |
| ------------------------------------------------------------------- | -------- | ----------------------------- | ------------------------ | -------------- |
| Money integrity (charged-no-ticket, double-charge/refund suspicion) | SEV1     | On-call Engineer + Finance    | **Page** now             | 15 min         |
| Payments provider down / checkout broken                            | SEV1     | On-call Engineer              | **Page**                 | 15 min         |
| Booking/confirm broken; can't buy                                   | SEV1     | On-call Engineer              | **Page**                 | 15 min         |
| Gate check-in down at a live event                                  | SEV1     | On-call Engineer + Admin      | **Page**                 | 15 min         |
| Database down / data corruption                                     | SEV1     | On-call Engineer              | **Page** → DR plan       | 15 min         |
| Security incident (breach, leaked creds, abuse)                     | SEV1     | Security Contact + On-call    | **Page** (see §5)        | 15 min         |
| Elevated errors / slow API / partial failures                       | SEV2     | On-call Engineer              | Ticket + channel         | 1 hour         |
| Queue backlog (emails/holds delayed)                                | SEV2     | Admin → On-call if stuck      | Ops console; then ticket | 1 hour         |
| One notification channel failing (email)                            | SEV2     | On-call Engineer              | Ticket                   | 1 hour         |
| Refund/payout dispute (policy/role)                                 | SEV2/3   | Platform Admin / Org Owner    | Support ticket           | 4 business hrs |
| Organizer "can't see revenue" (role scope)                          | SEV3     | Support → Org Owner           | Support ticket           | 4 business hrs |
| Single-user bug with workaround                                     | SEV3     | Support → Engineering backlog | Support ticket           | 4 business hrs |
| Feature request / question                                          | SEV3/P4  | Support → Product backlog     | Support ticket           | 1 business day |

Response targets align with the SLA table in the
[SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

## 4. Page vs ticket — the rule

- **Page** (phone/pager, wake someone up) when: SEV1, **or** an active live event
  is impacted, **or** money integrity is in question.
- **Ticket** (support inbox / tracker) when: SEV2 with a workaround, SEV3, or
  anything not time-critical. Support routes it to the owner above.
- When unsure between page and ticket at a **live event**, **page** — the cost of
  a false page is low compared to a stalled gate.

## 5. Financial-discrepancy escalation

1. Support/admin identifies a discrepancy (e.g. provider shows a charge with no
   confirmed booking, or refund/payout totals don't reconcile).
2. Pull evidence: `/admin/bookings`, `/admin/payments`, `/admin/refunds`,
   `/admin/payouts`, and the `/admin/audit` log; note `correlationId`s.
3. Escalate to **On-call Engineer + Finance** as **SEV1** if money moved
   incorrectly; otherwise SEV2 for reconciliation.
4. Do **not** issue manual provider-side corrections without Finance + Engineering
   sign-off. Remember refunds/payouts are single-issue by design — reconcile
   before acting.

## 6. Security-incident escalation

1. Suspected breach, leaked credentials, auth abuse (credential-stuffing beyond
   the auth rate limit), or data exposure → contact the **Security Contact** and
   **On-call Engineer** immediately; treat as **SEV1**.
2. Preserve logs and audit entries; do not tamper with evidence.
3. Follow the incident flow ([INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md)); consider
   maintenance mode if active exploitation is underway.
4. Coordinate any user-facing disclosure through the Program Owner.
