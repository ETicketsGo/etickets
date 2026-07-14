# ETicketsGo — Support Handbook

First-line support runbook. All state is in Postgres; the audit log records sensitive actions.

## Triage tools

- Health: `/api/health`, `/api/ready`. Metrics: `/api/metrics`. Structured JSON logs
  (search by `correlationId` returned in every error envelope `{code,message,details,correlationId}`).
- Admin portal: users, bookings, refunds, payouts, events, movies, audit.

## Common issues & resolutions

| Symptom                                   | Likely cause                                                     | Resolution                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "My seat/ticket didn't come through"      | Payment not confirmed (hold expired or provider webhook delayed) | Check booking status in admin. If `PENDING_PAYMENT` past hold, the seat auto-released — ask customer to rebook. If paid but not confirmed, check webhook logs by correlationId. |
| "Charged but no ticket"                   | Confirm rolled back (expired hold) — money captured              | The confirm guard prevents zero-ticket confirms; issue a refund via admin and reconcile with the provider.                                                                      |
| Double charge / double refund fears       | —                                                                | Impossible by design: confirm + refund + payout are atomic/idempotent (single-issue, single-refund, single-pay). Verify in audit log.                                           |
| "Seat shows taken but I didn't book"      | Another buyer holds it (10-min hold)                             | Hold auto-expires; seat returns to AVAILABLE.                                                                                                                                   |
| Refund request rejected as "not eligible" | Refund window (48h before showtime) or already-covered tickets   | Explain the window; confirm no open refund already covers the tickets.                                                                                                          |
| Organizer can't see revenue               | Role is CHECKIN_STAFF                                            | Financial reads require OWNER/MANAGER; escalate to the org owner.                                                                                                               |
| Movie booking "not available"             | Movie experience not published / show past                       | Check event status + show times in organizer/admin.                                                                                                                             |
| Login fails repeatedly then blocks        | Auth rate limit (10/min/route)                                   | Wait a minute; check for credential-stuffing in logs.                                                                                                                           |

## Escalation

- Financial discrepancy → Engineering + Finance (pull audit log + payment provider record by `providerRef`).
- Suspected security event (refresh-token reuse triggers family revocation → forced re-login) → Security.
- Data incident → follow DISASTER-RECOVERY.

## What support can/can't do

- Can: look up bookings/tickets/refunds, resend notifications (once wired), approve/reject refunds (admin), read audit.
- Cannot: edit money records directly (immutable snapshots), bypass RBAC/tenant isolation, or issue tickets without a confirmed booking.
