# ETicketsGo — Check-in Staff Guide (Pilot)

For gate/door staff scanning tickets at an event. Short, practical, and honest
about what the scanner can and cannot do.

> Your role: **CHECKIN_STAFF** (organizer owners and managers can also scan).
> You can only scan tickets belonging to **your** organization.

---

## 1. Before the doors open

1. Sign in to **organizer-web** on the scanning device.
2. Open the event's check-in screen:
   `/organizer/events/[id]/checkin`.
3. Make sure the device is **online**. Check-in is **online-only** — there is no
   offline queue. If you lose connection, the screen shows
   _"You're offline — scans will fail until the connection returns,"_ and scans
   will not go through until you're back online.

![screenshot: /organizer/events/[id]/checkin scanner ready]

## 2. Scanning a ticket

1. Point the scanner at the customer's **QR code** (in their ticket detail or
   wallet on customer-web).
2. Each scan sends the QR token to `POST /api/checkins` (with the expected
   session). The screen shows one of the result states below.
3. Admit or hold the guest based on the result.

## 3. Result states — what they mean and what to do

| Result            | Meaning                                                             | What to do                                                                                           |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **SUCCESS**       | Valid ticket, first check-in. Status flipped ACTIVE → CHECKED_IN.   | **Admit.** Green result.                                                                             |
| **DUPLICATE**     | Already checked in (someone used this ticket already).              | **Do not admit** by default. Verify identity; this ticket was already scanned. Escalate if disputed. |
| **INVALID**       | Code won't verify, ticket not found, or the code was tampered with. | **Do not admit.** Ask for the ticket in their account; try again. If it persists, escalate.          |
| **WRONG_SESSION** | A real ticket, but for a **different session/showtime**.            | **Do not admit** to this session. Direct them to the correct session, or escalate.                   |
| **CANCELLED**     | Ticket is cancelled, refunded, or void.                             | **Do not admit.** The ticket is no longer valid.                                                     |

> Every scan — success or not — is logged (with device info) and success/failure
> is counted in metrics (`etg_qr_checkin_success_total` /
> `etg_qr_checkin_failure_total`). Successful check-ins are also written to the
> audit log.

## 4. Edge cases

- **No signal / spotty Wi-Fi.** Scans fail while offline (no offline queue). Move
  to where there is signal, use a mobile hotspot, or fall back to a manual guest
  list and reconcile later. Do not let the queue back up on a dead connection.
- **Customer can't load their QR.** Have them open
  `/account/tickets/[ticketId]` on customer-web (they may need to log in). Ticket
  detail shows the QR.
- **QR looks screenshotted/shared.** The first valid scan wins (atomic ACTIVE →
  CHECKED_IN); the second returns **DUPLICATE**. Treat a DUPLICATE as a possible
  shared/forwarded ticket and verify identity.
- **Multiple tickets in one booking.** Each ticket has its own QR — scan each.

## 5. Reversing a check-in

A mistaken check-in can be reversed, but **only by an ORGANIZER_OWNER or
ORGANIZER_MANAGER** — not by CHECKIN_STAFF.

1. An owner/manager calls **reverse** (`POST /api/checkins/reverse` with the
   ticket id).
2. This only works on a ticket currently `CHECKED_IN`; it returns it to `ACTIVE`
   and marks the prior successful check-in as reversed. It is written to the audit
   log.
3. The guest can then be re-scanned normally.

If you're CHECKIN_STAFF and need a reversal, **escalate to your manager/owner**.

## 6. Escalation

- **First stop:** the event's organizer owner/manager on site.
- Persistent INVALID across many guests, or the scanner not loading → escalate to
  your program/support contact. Support triages via the
  [SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md); a systemic outage follows
  [INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md) and
  [ESCALATION-MATRIX](./ESCALATION-MATRIX.md).
- For any dispute, capture the ticket serial and the on-screen result — both are
  recoverable from the check-in log and audit log.
