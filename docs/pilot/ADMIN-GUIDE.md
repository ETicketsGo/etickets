# ETicketsGo — Platform Admin Guide (Pilot)

For **ADMIN** / **SUPER_ADMIN** operators. All routes below are in **admin-web**
(`/admin/*`); API paths use the `/api` prefix.

> Access requires an admin role. Sensitive actions are written to the **audit
> log** (`/admin/audit`).

---

## 1. Dashboard

`/admin` (`GET /api/admin/dashboard`) — platform-wide snapshot: GMV, bookings,
refunds, and health at a glance. Start here each shift.

## 2. Review & approve organizers

1. `/admin/organizers` lists organizations, filterable by status.
2. Open an organizer at `/admin/organizers/[id]`.
3. Approve/reject a pending organization via `POST /api/admin/organizers/:id/review`.

## 3. Review & approve events

1. `/admin/events` lists events; filter by `EventStatus`
   (`DRAFT`, `UNDER_REVIEW`, `PUBLISHED`, `PAUSED`, `SOLD_OUT`, `CANCELLED`,
   `COMPLETED`, `ARCHIVED`).
2. Open an event at `/admin/events/[id]`.
3. For an event **UNDER_REVIEW**, approve or reject via
   `POST /api/admin/events/:id/review` (rejection carries a reason). Approval →
   **PUBLISHED**.
4. You can also force a status directly via `POST /api/admin/events/:id/status`
   (use sparingly).

## 4. Manage bookings & payments

- **Bookings** — `/admin/bookings`, detail at `/admin/bookings/[id]`
  (`GET /api/admin/bookings`). Inspect status, tickets, and the linked payment.
- **Payments** — `/admin/payments` (`GET /api/admin/payments`). Cross-check a
  payment's status and provider reference.
- **Fee rules** — visible via `GET /api/admin/fee-rules`.

> By design, confirm/refund/payout are atomic and idempotent — there is no
> double-charge, double-refund, or double-payout path. Verify anomalies in the
> audit log before acting.

## 5. Approve / reject refunds

1. `/admin/refunds` lists refund requests; filter by `RefundStatus`
   (`GET /api/admin/refunds`). Detail at `/admin/refunds/[id]`.
2. **Window rule:** a refund is eligible only while the booking is `CONFIRMED` or
   `PARTIALLY_REFUNDED` **and** the request was made **more than 48 hours before**
   the session start. Requests outside this are rejected as _not eligible_ at
   request time.
3. Decide with `POST /api/refunds/:id/process` (`APPROVE` / `REJECT`). Approval:
   - claims the refund atomically (no concurrent double-approval),
   - calls the payment provider **exactly once** (on failure → `FAILED`, never
     stuck `PROCESSING`),
   - voids the covered tickets (`REFUNDED`), returns seats/stock,
   - sets the booking to `REFUNDED` or `PARTIALLY_REFUNDED`,
   - emails the customer.
4. Organizer **owners** can also approve their own org's refunds; platform admins
   can approve any.

## 6. Payouts

1. `/admin/payouts` lists payouts across organizers (`GET /api/admin/payouts`).
2. When funds have been sent out-of-band, **mark paid** via
   `POST /api/admin/payouts/:id/pay` (`PENDING`/`SCHEDULED` → **PAID**, stamps
   `paidAt`).
3. Marking paid is a bookkeeping action — the pilot does not integrate a bank
   payout rail. Reconcile against your provider/bank manually.

## 7. Business reports

`/admin/reports` renders revenue, organizer breakdowns, settlement, and refunds,
each with **CSV export**. CSV report names:

| Report              | Contents                                 |
| ------------------- | ---------------------------------------- |
| `daily-revenue`     | Revenue by day (date range)              |
| `organizer-revenue` | Revenue by organizer (date range, limit) |
| `settlement`        | Settlement position by organizer         |
| `refunds`           | Refunds over a date range                |

> **Tax is not modelled.** Report figures are pre-tax gross/net; do not present
> them as tax-inclusive.

## 8. Support inbox

`/admin/support` (`GET /api/admin/support`) is the triage queue for all
submissions from the feedback widget and help forms.

- **Kinds** (`FeedbackKind`): `CONTACT`, `BUG`, `FEATURE`, `GENERAL`, `CSAT`,
  `ORGANIZER_CSAT`. CSAT kinds carry a 1–5 rating.
- **Status** (`FeedbackStatus`): `OPEN` → `TRIAGED` → `CLOSED`. Update via
  `PATCH /api/admin/support/:id`.
- Work the queue per the [SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

## 9. Operations console

`/admin/ops` is the live health + queue + flags console
(`/api/admin/ops/*`, read-mostly):

- **System health** — `GET /api/admin/ops/health`: database, redis, queue, and
  storage (reported `not_configured`), plus uptime and node env.
- **Queues** — `GET /api/admin/ops/queues` (counts + repeatable jobs),
  `GET /api/admin/ops/queues/failed` (failed jobs).
- **Retry failed jobs** — `POST /api/admin/ops/queues/retry-failed` (batch) or
  `POST /api/admin/ops/queues/jobs/:id/retry` (single). Used to drain the `holds`
  queue backlog — see [INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md).
- **Maintenance mode** — `GET`/`POST /api/admin/ops/maintenance`. Redis-backed,
  **off by default**, **fail-open** (if Redis can't be read the site stays up),
  and it **exempts** health/critical routes so you don't lock yourself out. Turn
  it on with an optional customer-facing message during a SEV1.
- **Feature flags** — `GET /api/admin/ops/flags`. **Read-only display.** Flags
  resolve from environment at boot (`FEATURE_<NAME>` / `NEXT_PUBLIC_FEATURE_<NAME>`);
  there is no runtime toggle store in the pilot. Enterprise flags are off by
  default.

For the full metrics catalog and alerting, see
[MONITORING](../guides/MONITORING.md) and [OPERATIONS](../reports/OPERATIONS.md).

## 10. Audit log

`/admin/audit` (`GET /api/admin/audit`) records sensitive actions — event
reviews, refunds (requested/approved/rejected/completed), check-ins and
reversals, payouts. Use it to answer "who did what, when" during any dispute or
incident.

## 11. User management

`/admin/users` — look up users and their roles (`Role` enum). Use it to confirm a
person's role when diagnosing "I can't see/do X" reports (most are role-scope
issues).

Platform settings live at `/admin/settings`.
