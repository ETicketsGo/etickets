# ETicketsGo — Pilot Incident Response

How to detect, respond to, and learn from incidents during the pilot. Pairs with
the [ESCALATION-MATRIX](./ESCALATION-MATRIX.md),
[OPERATIONS](../reports/OPERATIONS.md),
[MONITORING](../guides/MONITORING.md), and
[DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md).

---

## 1. Severity levels

| Severity | Definition                                                               | Examples                                                                                                                             |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **SEV1** | Money integrity at risk, or customers cannot buy / cannot get in at all. | Charged-but-no-ticket, payment provider down, booking/confirm broken, gate check-in down, DB down, suspected oversell/double-charge. |
| **SEV2** | Degraded but functioning; a workaround exists.                           | Slow API, elevated payment failures, queue backlog delaying emails/holds, one channel failing.                                       |
| **SEV3** | Minor, low-impact.                                                       | Cosmetic bug, single-user edge case, non-critical report glitch.                                                                     |

## 2. Detection

- **Metrics/alerts** — `/api/metrics` (Prometheus). Watch payment failure vs
  success (`etg_payments_failed_total` / `etg_payments_succeeded_total`), QR
  check-in failure rate, HTTP 5xx, DB/slow-query metrics. Alert thresholds live in
  [MONITORING](../guides/MONITORING.md).
- **Sentry** — error spikes and new exception types.
- **Health** — `/api/health`, `/api/ready`, and the ops console
  `/admin/ops` → `GET /api/admin/ops/health` (database / redis / queue / storage).
- **Humans** — support tickets and organizer/customer reports (often the first
  signal at a live event).

## 3. Response flow

1. **Declare.** Anyone can declare an incident. State the **severity** and open a
   channel/thread. Assign an **Incident Lead** (per
   [ESCALATION-MATRIX](./ESCALATION-MATRIX.md)).
2. **Assess.** Confirm blast radius with metrics + `/admin/ops` + audit log. Grab
   `correlationId`s from failing requests.
3. **Mitigate.** Stop the bleeding before root-causing:
   - Turn on **maintenance mode** if needed (`POST /api/admin/ops/maintenance`
     with a customer message) — it's fail-open and exempts health routes, so it
     won't lock out operators.
   - Drain a **queue backlog** via the ops console retry
     (`POST /api/admin/ops/queues/retry-failed`).
   - For a bad deploy, prepare a **rollback** (§4).
4. **Communicate.** Post status to the pilot cohort and internally at a steady
   cadence (see templates §6). Keep organizers running a live event informed.
5. **Resolve.** Verify recovery in metrics/health; turn maintenance mode **off**;
   confirm with the reporter.
6. **Postmortem.** For every SEV1 and SEV2, write a blameless postmortem
   (timeline, impact, root cause, action items with owners). Track actions to
   done.

## 4. Rollback

- **Redeploy the prior good tag/image.** See
  [DEPLOYMENT](../guides/DEPLOYMENT.md) for the deploy/rollback procedure.
- **Migrations are additive** — rolling app code back does not require a down
  migration in the normal case. If a migration is implicated, coordinate with
  engineering and consult [DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md)
  before touching data.
- After rollback, re-run smoke tests (see
  [LAUNCH-CHECKLIST](./LAUNCH-CHECKLIST.md) §smoke).

## 5. Specific runbooks

### Payment provider outage (SEV1)

1. Confirm via provider status page + spiking `etg_payments_failed_total` +
   Sentry.
2. New checkouts will fail at the payment step; unpaid bookings simply expire
   (10-min hold) — no ticket is issued, so there's no oversell.
3. Consider **maintenance mode** with a "payments temporarily unavailable"
   message if the failure rate is high.
4. Do **not** manually confirm bookings. When the provider recovers, verify the
   webhook path processes backlog; reconcile any captured-but-unconfirmed payments
   via `/admin/payments` and refund if money moved without a ticket.

### Database issue (SEV1)

Follow [DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md): Postgres is the single
system of record (bookings, tickets, payments, refunds, payouts, audit). Redis
cache loss is harmless; queue loss is tolerable (lazy hold-expiry + re-runnable
dispatch). Restore via PITR to just before the incident, re-point `DATABASE_URL`,
run `npm run db:deploy`.

### Queue backlog (SEV2)

1. `/admin/ops` → `GET /api/admin/ops/queues` shows `holds` queue counts;
   `.../queues/failed` lists failures.
2. Retry the batch with `POST /api/admin/ops/queues/retry-failed`, or a single job
   with `.../jobs/:id/retry`.
3. Backlog delays emails and scheduled hold sweeps but does not corrupt state —
   holds still expire lazily on the read path.

### Suspected oversell / double-charge / double-refund (SEV1 claim)

1. **Reassure and verify, don't patch blindly.** These are prevented by design:
   seat/stock transitions and confirm/refund/payout are **atomic and idempotent**
   (single-issue, single-refund, single-pay; DUPLICATE check-in is a no-op).
2. Pull the **audit log** (`/admin/audit`) and the relevant booking/payment/refund
   rows to reconstruct the true sequence.
3. If the data confirms a genuine anomaly, escalate to engineering immediately and
   treat as SEV1 with a postmortem. If not, close with the evidence.

## 6. Comms templates

**Initial (internal + cohort):**

> ⚠️ **[SEVn] <short title>** — declared <time, tz>. Impact: <who/what>. Current
> status: investigating. Incident Lead: <name>. Next update by <time>.

**Update:**

> 🔎 **[SEVn] <title>** — <mitigation in progress / identified cause>. Customer
> impact now: <...>. Next update by <time>.

**Resolved:**

> ✅ **[SEVn] <title>** — resolved <time>. Cause: <one line>. Customer impact:
> <duration/scope>. Postmortem to follow by <date>.

**Customer-facing (maintenance banner):**

> We're doing brief maintenance and some actions may be unavailable. We'll be back
> shortly — thanks for your patience.
