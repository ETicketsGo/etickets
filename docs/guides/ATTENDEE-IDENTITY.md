# Attendee Identity Layer (ADR-031)

The identity layer that lets a **ticket belong to a person**, not just to the
purchaser. Reused by every experience type (events, movies, attractions,
memberships) with no per-type code. Additive and backward-compatible; it never
touches the booking engine, inventory strategy, payment platform, or the QR
signing algorithm.

## Data model (extends `Ticket`; no duplicate attendee table)

- **`Ticket`** gains attendee identity, additive + nullable:
  - `assignmentStatus` (`UNASSIGNED | ASSIGNED | INVITED | ACCEPTED | DECLINED`) —
    the assignment lifecycle, **orthogonal** to `Ticket.status` (the gate/refund
    lifecycle). A ticket can be `ACCEPTED` (identity) and `CHECKED_IN` (gate).
  - `attendeeUserId` → the claiming account (drives their wallet).
  - `holderName` / `holderEmail` (existing) = the attendee's name/email, plus
    `attendeePhone/Country/Company/Designation/StudentId/MemberId` and
    `attendeeCustomFields` (JSON, for configurable per-experience fields).
- **`TicketInvite`** — a tokenised invite/transfer ledger (not an attendee table):
  `kind` (INVITE | TRANSFER), `status` (PENDING | ACCEPTED | DECLINED | REVOKED |
  EXPIRED), `email`, **`tokenHash`** (only a SHA-256 hash is stored — never the
  raw token), `expiresAt`, `createdByUserId`, `acceptedByUserId`.

Migration `20260715120000_attendee_identity` is additive and backfills existing
confirmed tickets to `ASSIGNED` with the buyer as attendee, so history stays true.

## Flows

### Assign (direct)

Owner sets the holder on a ticket. If the email matches an account, `attendeeUserId`
is linked so it appears in that person's wallet. Audited `ATTENDEE_ASSIGNED`.

### Invite / Transfer

Owner invites by email → a random token is generated, its **hash** stored with a
7-day expiry, prior pending invites are `REVOKED` (only one live claim link), the
ticket becomes `INVITED`, and an `ATTENDEE_INVITED` notification is sent. The raw
token is returned once so the owner can also copy the `/invite/<token>` link.
Transfer is the same mechanism with `kind = TRANSFER`.

### Accept → **QR rotation**

Recipient (signed in) accepts. In one transaction the invite is marked `ACCEPTED`
and the ticket is relinked (`attendeeUserId`, holder name/email, status `ACCEPTED`)
**and its `nonce` is rotated + `qrVersion` incremented**. Because check-in compares
`ticket.nonce` to the scanned QR's nonce, the previously-shared QR is now
**invalid** — there is only ever one valid QR per ticket. The original owner is
notified `ATTENDEE_ACCEPTED` (or `TICKET_TRANSFERRED`).

### Decline / Unassign

Decline returns the ticket to `UNASSIGNED` for the owner to reassign. Unassign
clears the attendee, revokes pending invites, and **rotates the QR** so any code
already shared stops working.

## QR ownership rule

> One ticket → one valid QR. Ownership change → nonce rotates → old QR dies →
> new QR is issued to the new holder. Enforced in `AttendeesService` and verified
> at the gate by the existing nonce check (`checkins.service.ts`).

## Wallet scoping ("My Experiences")

The wallet returns a ticket when the viewer is **either** the booking owner **or**
the assigned attendee (`booking.userId = me OR attendeeUserId = me`). The response
carries `assignmentStatus`, `attendeeName`, `ownedByViewer`, `assignedToViewer` so
the UI shows "This ticket is yours" vs "Assigned to …" vs "Invitation sent".

## API (RESTful, backward compatible)

| Method + path                           | Who         | Purpose                               |
| --------------------------------------- | ----------- | ------------------------------------- |
| `POST /tickets/:id/attendee`            | owner/admin | Assign directly                       |
| `POST /tickets/:id/invite`              | owner/admin | Invite by email (returns claim token) |
| `POST /tickets/:id/transfer`            | owner/admin | Transfer to another person            |
| `POST /tickets/:id/unassign`            | owner/admin | Clear attendee + rotate QR            |
| `GET  /bookings/:id/attendees`          | owner/admin | Assignment summary + counts           |
| `POST /attendee-invites/:token/accept`  | recipient   | Claim ticket + rotate QR              |
| `POST /attendee-invites/:token/decline` | recipient   | Decline                               |
| `POST /attendee-invites/:id/resend`     | owner/admin | Re-issue a fresh link                 |

## Security

- **Tokens:** 192-bit random; only the SHA-256 **hash** is stored; single live
  token per ticket (older ones `REVOKED`); resend rotates the token.
- **Expiry + replay:** expired tokens are rejected and marked `EXPIRED`; accepted/
  declined/revoked tokens can't be reused (`status` gate).
- **RBAC + tenant isolation:** manage endpoints require the booking owner (or
  admin); `organizationId` is stamped on every invite; staff check-in is already
  org-scoped.
- **Rate limits:** the global throttler applies; **audit** records every assign /
  invite / accept / decline / transfer / unassign / QR rotation.
- **Privacy:** the wallet never exposes another attendee's private profile; the
  owner sees only the assignment info they provided; organizers see only what the
  gate needs (name, seat, reference, status).

## Backward compatibility

All columns are additive/nullable; legacy tickets read fine (backfilled to
`ASSIGNED`). No booking/payment/inventory/QR-signing change. Older wallet payloads
without the new fields degrade gracefully in the UI.
