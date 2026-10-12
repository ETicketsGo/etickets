# India pilot operating procedures

Prepared 2026-10-12 from the repository at `origin/main e3e289e`. Scope: a controlled India pilot with
3 to 5 organizers and about 10 general-admission (GA) events, INR through Razorpay. Regulated cinema
ticketing stays off.

## How to read this

- **Evidence.** Every step cites the code or console label it rests on. The code was read at the commit
  above. **No live environment (QA, UAT, production) was queried or written** while preparing this. Where a
  step depends on live state, it is marked **VERIFY LIVE** and names the check.
- **Console labels** are the labels in `apps/admin-web/lib/admin-nav.ts` and the pages under
  `apps/admin-web/app/admin` and `apps/organizer-web/app/organizer`.
- **This document grants nothing.** Section 7 lists the staff duties the owner must grant. Only a holder of
  `ADMIN_MANAGE` can grant them, in the console, under Staff & duties.
- **Problems found.** Where the product cannot support a step as written, the step says so and the problem is
  numbered G1, G2, ... in section 12. Read section 12 before the pilot starts.
- Existing documents this builds on and, in places, corrects: `docs/pilot/PILOT-GUIDE.md`,
  `ORGANIZER-GUIDE.md`, `CHECKIN-GUIDE.md`, `SUPPORT-PLAYBOOK.md`, `ESCALATION-MATRIX.md`,
  `INCIDENT-RESPONSE.md`, `docs/security/ADMIN-PERMISSION-MATRIX.md`, `docs/ops/BACKUP-RUNBOOK.md`,
  `docs/guides/PAYOUT-LIFECYCLE.md`. The companion file `docs/pilot/PILOT-JOURNEY.md` follows one ticket
  end to end.

## Pilot ground rules

1. **GA only.** A GA session has no room or seat map, and the buyer picks a quantity
   (`apps/api/src/bookings/bookings.service.ts`, "Reserved seating, decided by the ROOM"). Do not onboard
   cinemas or reserved-seating events in the pilot.
2. **Event approval is manual.** Per-organizer auto-approve (`Organization.autoApproveEvents`, default
   `false`, `apps/api/prisma/schema.prisma`) stays off for every pilot organizer.
3. **Payouts are manual.** Money reaches organizers by a bank transfer a person makes outside the platform
   and then records (`PayoutsService.markPaid`, `apps/api/src/payouts/payouts.service.ts`). The provider
   transfer path (`/admin/settlements`, Razorpay Route) stays off: `PAYOUT_EXECUTION_ENABLED` and
   `RAZORPAY_ROUTE_ENABLED` must be false. **VERIFY LIVE** (variable names only, never values).
4. **Refunds are manual.** `BOOKING_REFUND_POLICY_MODE` is `MANUAL_ONLY`: every refund is a request that a
   person approves (`apps/api/src/refunds/refunds.service.ts`).
5. **Platform staff never act as a customer or as an organizer.** See sections 6 and 8.
6. **Never type or paste a bank account number** into a reason, note or chat. The API refuses reasons that
   look like one (`looksLikeAccountNumber`, `apps/api/src/payouts/payout-account-safety.ts`).

---

## 1. Organizer onboarding checklist

**Who.** Organizer owner (applies). A reviewer with `ORGANIZER_REVIEW` (the Moderation duty) decides.
**Where.** Organizer console `/start`, then admin console Organizers.

### Steps

1. **Organizer registers** at the organizer console `/start`. The form asks for "Organization name",
   "Support email (optional)", "Country you are registered in", "Registered as" and "Registered legal name"
   (`apps/organizer-web/app/start/page.tsx`). The organization is created `PENDING`
   (`OrganizationsService.register`). One account may have at most 2 organizations waiting for review
   (`organization-limits.ts`).
2. **Organizer completes readiness** at `/organizer/onboarding` ("Get started") and `/organizer/settings`
   ("Legal and tax details"). Two items are BLOCKING
   (`apps/api/src/organizations/organization-readiness.ts`): the payout bank account and the legal identity.
3. **Reviewer opens** Organizers (`/admin/organizers`) and picks the organization. The detail page shows
   "Details", "Review", "Publishing", the standing and readiness card, "Legal identity" and "Team".
4. **Reviewer checks every item below and records the evidence** (section "Evidence to keep").
5. **Reviewer decides.** In the "Review" card, add a note and press "Approve" or "Reject". Approval writes
   `ORGANIZATION_APPROVED`; rejection writes `ORGANIZATION_REJECTED`. The owners get an email either way
   (`organizations.service.ts`, `review`). A rejection note is emailed to them, so write it for the organizer.
6. **Reviewer leaves "Publishing" alone.** It must read "Every event they submit waits for a reviewer before
   it can sell a ticket." Do not press "Skip review for them" (section 2).

### What the reviewer checks

| Check                                                                                                                     | Where                                  | Pass condition                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Legal name, entity type, country of registration                                                                          | "Legal identity" card                  | All three present. The API refuses approval otherwise (409).     |
| The legal name matches an outside document (certificate of registration, PAN card, GST certificate where the org has one) | Document the organizer sends by email  | Names match. Presence only is checked by the code, not format.   |
| Country is India for the pilot                                                                                            | "Legal identity" card, list "Country"  | India. There is no market switch in code (G6), so this is human. |
| Contact: a working support email and a named contact                                                                      | "Details" card; finance contact fields | Email answers a test message from the pilot support inbox.       |
| Registered address, finance contact, complaints contact                                                                   | "Legal identity" card                  | Filled. They are IMPORTANT, not BLOCKING.                        |
| Bank account entered by the OWNER and shown as "Waiting for verification"                                                 | Payouts, "Bank accounts" card          | A row exists for INR (section 5 verifies it, not this step).     |
| Tax registration number (GSTIN)                                                                                           | "Legal identity" card                  | Optional. Without it buyers get receipts, not tax invoices.      |
| Event plan is GA only                                                                                                     | Conversation with the organizer        | No cinema, no reserved seating, no Telangana cinema sales.       |

Do not use the override. The API accepts `overrideIdentityCheck` with a written reason to approve without
identity fields, but the console cannot send it (G7), and the pilot rule is "no identity, no approval".

### What approval does and does not do

- Approval alone does **not** let an organizer sell. Selling needs a published event, which needs an event
  approval (section 2).
- A `PENDING` or `REJECTED` organizer can still create venues and draft events. There is no status check in
  `events.service.ts` or `bookings.service.ts` (G5). The control is the event review step. Only `SUSPENDED`
  organizers are refused at checkout ("is not selling tickets at the moment").
- A payout account and a tax number do not gate selling. They gate getting paid and tax invoices.

### Suspend and reinstate

`Organizers > organization > standing card`. A reason is required and is readable by support and the
organizer (`organization-lifecycle.service.ts`). Suspension stops checkout. Reinstating returns the
organization to `APPROVED`.

### Evidence to keep (per organizer)

- The document copies or photos the organizer sent, filed outside the repository in the pilot folder.
- The audit rows `ORGANIZATION_CREATED`, `ORGANIZATION_APPROVED` or `ORGANIZATION_REJECTED`, and
  `PAYOUT_ACCOUNT_SAVED` (Audit log, filter by organization).
- The reviewer's note text and the date.

---

## 2. Event approval workflow

**Who.** Reviewer with `EVENT_REVIEW` (Moderation duty). The organizer submits.
**Where.** Admin console, Events > "Approval queue" (`/admin/events`, default filter "Waiting for review").

### Lifecycle

`DRAFT` > `UNDER_REVIEW` > `PUBLISHED`. A reject returns the event to `DRAFT` with the reviewer's note.
Other states: `PAUSED`, `SOLD_OUT`, `CANCELLED`, `COMPLETED`, `ARCHIVED` (`schema.prisma`, `EventStatus`).

### Steps

1. **Organizer submits.** On the event page they press "Submit for approval". The server first runs the
   sellability check and refuses an event that checkout would refuse (`events.service.ts`,
   `submitForReview`; `event-sellability.service.ts`). The event needs at least one session and one ticket
   type. It goes to `UNDER_REVIEW` and admins get an "Event awaiting review" email.
2. **Reviewer opens the event** (`/admin/events/[id]`) and checks the list below.
3. **Reviewer decides.** In the "Moderation" card add a "Reviewer note (optional)" and press "Approve" or
   "Reject". Approve sets `PUBLISHED`. Reject sets `DRAFT`. Both are audited (`EVENT_APPROVED`,
   `EVENT_REJECTED`) and the organizer owners are emailed.
4. **Write a reason on every rejection.** The API does not require one (G8). The pilot rule does, because the
   organizer receives only that text.

### What the reviewer checks

| Check                     | Pass condition                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Organizer standing        | `APPROVED` and not suspended (organizer detail page).                                                       |
| Event is GA               | Sessions have no room or seat map. No cinema.                                                               |
| Title, description, image | Plain, truthful, no misleading claim, no copied artwork. Images are held in Postgres and served by the API. |
| Date, time, venue, city   | Real, in the future, and the venue is in India. The venue country decides the currency.                     |
| Age limit, terms, artists | Present where relevant ("Details" card).                                                                    |
| Ticket types and prices   | Each price is in INR, matches what the organizer promised, and is above zero for a paid event.              |
| Fee handling              | "Fee handling" shows the organizer's choice (customer pays, organizer pays, shared). It must be intended.   |
| Free vs paid              | A free event has price zero on every ticket and the free flag set. Free events skip payment entirely.       |
| Refund settings           | Refunds on or off and the cutoff are the organizer's choice. Confirm they match what the buyer is told.     |
| Capacity                  | "Quantity on sale" is the number the organizer will sell, not the venue's capacity.                         |

### Auto-approve stays off

- It is per organization, set only through `PATCH /admin/organizers/:id/auto-approve`. There is no global
  setting and no environment variable.
- To confirm it is off, open Organizers > organization. The "Publishing" card says "Every event they submit
  waits for a reviewer before it can sell a ticket." The button reads "Skip review for them".
- To audit it, filter the Audit log by action `ORG_AUTO_APPROVE_ENABLED`. Any `EVENT_AUTO_APPROVED` row means
  an event went live without review and is an incident (section 9).
- The API refuses to switch it on unless the organizer is approved and has had one event published, so it
  cannot be on for a new pilot organizer by accident.

### Pausing or pulling a live event

Event page > "Pause event" or "Cancel event" (`POST /admin/events/:id/status`, audited
`EVENT_STATUS_CHANGED`). Only an admin can lift an admin pause. **Cancelling an event here opens no refunds
and cancels no sessions** (G3). Follow section 4 instead.

---

## 3. Ticket creation guidance for GA

**Who.** Organizer owner or manager. **Where.** Organizer console, Events > event > Tickets
(`/organizer/events/[id]/tickets`), or the event wizard `/organizer/events/new`.

### Rules the organizer must follow

1. **One event, one or more sessions, ticket types per session.** A ticket type belongs to a session
   (`TicketType`, `schema.prisma`).
2. **Choose "Paid - general admission"** in the wizard ("How do people get in"). Do not choose "Reserved
   seating".
3. **Price** is entered in rupees. The field label shows "Price (INR)" with the currency taken from the
   venue country. A paid ticket needs a price above zero.
4. **"Quantity on sale"** is how many tickets will be sold, at least 1. It is not the venue capacity.
5. **"Max per order"** is 1 to 50. The default is 10. It cannot be above the quantity on sale.
6. **Names must be unique within a session** (case-insensitive).
7. **Prices lock after the first sale.** The API refuses a price change ("Price cannot be changed after
   tickets have sold."). To change a price, switch the ticket to inactive and add a new ticket type.
8. **Quantity cannot go below sold plus held.** A ticket type with sales cannot be deleted. Deactivate it.
9. **There is no sales-window input in the console** (G9). Tickets are on sale from publish until the event
   ends, unless support sets dates through the API. Tell organizers not to plan on a timed release.

### What the buyer is charged (so the organizer can explain it)

From `docs/INDIA_GST_BUSINESS_DECISIONS.md` (not tax advice, rates unverified by an accountant): the buyer
pays the ticket face value plus a booking fee (banded), plus a payment fee, plus GST on those fees, when the
organizer chose "Customer pays fees". GST on the ticket is inside the face value. **VERIFY LIVE:** whether
GST is active on the pilot environment. A production note dated 2026-10 says production charged tax 0 on INR
and that activating it raises the buyer total (`docs/ops/PRODUCTION-READINESS-2026-10.md`, row 15). Do not
quote a buyer total to an organizer until the Booking fees and Tax rules pages have been checked.

### Reviewer check before approving

Open `/admin/events/[id]`, "Sessions & tickets": each line reads "name - price x quantity". Compare with the
organizer's brief. Fix anything wrong by rejecting with a note, not by editing for them.

---

## 4. QR check-in

**Who.** Gate staff (`CHECKIN_STAFF`), organizer manager or owner. **Where.** `/organizer/gate` (the staff
screen) and `/organizer/events/[id]/checkin` (the full screen). Platform staff cannot scan unless they are an
active member of that organization (`CheckinsService`, `assertMember`).

### Before the event (organizer owner, 48 hours ahead)

1. **Invite gate staff.** `/organizer/team` > "Add someone" > role "Check-in staff" ("Scan tickets at the
   door. No access to sales, money or settings."). Only an owner can invite. The console shows a link to
   copy and send. It does not email it. The link works once and expires in 7 days.
2. **Test the invited account on the real gate screen before event day.** **Known risk (G2):** invited gate
   staff keep the global role `CUSTOMER`, and the check-in controller also checks that global role. An invited
   scanner may be refused. Seeded staff are not affected. This must be tested on QA with a freshly invited
   account before the pilot, and again on the live environment before the first event.
3. **Open the gate screen on the gate phone** and pick the show ("Choose the show you are on the door for").
   Shows from 6 hours ago to 18 hours ahead are listed.
4. **Decide the gate method.** Two options:
   - **Online scanning** with the camera or by typing the code. Needs a connection. This is the pilot default.
   - **Offline mode** on `/organizer/events/[id]/checkin` ("Offline mode" panel) and `/devices`. It exists
     only while `OFFLINE_CHECKIN_ENABLED` is on, which is off by default (G4). **Do not rely on it unless the
     owner has turned it on and run the preflight (`/organizer/events/[id]/preflight`, "Offline preflight").**
5. **Print a fallback list.** An owner or manager can export the attendee list. Check-in staff cannot
   (`event-attendees.service.ts`, `EXPORT_ROLES`). Keep the print-out in a closed folder, not on a wall.

### At the gate

1. Scan the QR or type the code. Read the result tile:

| Result (screen)                    | Meaning                                                            | Gate action                                         |
| ---------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| "Let them in" / "Ticket accepted." | `SUCCESS`. Ticket moved from active to checked in, atomically.     | Admit.                                              |
| "Already used"                     | `DUPLICATE`. Someone has scanned it.                               | Do not admit. Call the supervisor.                  |
| "Wrong show"                       | `WRONG_SESSION`. Ticket is for another session.                    | Check date and time. Do not admit to this show.     |
| "Cancelled"                        | `CANCELLED`. Booking cancelled, refunded or void.                  | Do not admit.                                       |
| "Not valid"                        | `INVALID`. Bad signature, unknown ticket, or any API error.        | Retype the code once. Then call the supervisor.     |
| (no tile, "Ready to scan")         | `EXTERNAL` ticket from a venue system, or a screen fault. See G10. | Call the supervisor. Pilot GA events do not use it. |

2. **A scan error is not proof the ticket is false.** The gate screen shows every API error as "Not valid",
   including a lost connection (G11). If several scans in a row fail, check the phone's connection first.
3. **Duplicate scans.** Two scans of one QR: the first wins and the second shows "Already used". The
   supervisor asks the second holder for the booking reference and looks the booking up (below). Do not
   un-check the first scan to let the second person in.
4. **Manual entry.** On the full check-in page, "Admit by eye" searches by seat, name or reference. "Find
   attendee" shows the attendee without email, phone or payment for gate staff. Use it only when the holder
   shows a booking confirmation. An admit-by-eye is recorded as a visual check (`TICKET_ADMITTED_VISUALLY`).
5. **Undo a mistaken scan.** Only an owner or manager can press "Reverse check-in" (`CHECKIN_REVERSED`).
   Gate staff see the button and get a refusal. Reverse only the wrong person's scan, never a duplicate.
6. **Offline devices (only if enabled).** Register on `/devices` ("Register device"), an owner or manager
   presses "Approve" (active for 30 days), and the device downloads a signed manifest (valid 6 hours). Offline
   decisions that the manifest cannot confirm return "requires online validation", never valid. Failed
   uploads go to a dead-letter list that can be downloaded. After reconnecting, a supervisor resolves the
   cases on `/organizer/events/[id]/reconciliation` ("Needs review"). Revoking a device blocks its upload
   but does **not** stop that person scanning online (G12).

### Evidence to keep

Per event: the Audit log rows `TICKET_CHECKED_IN`, `TICKET_ADMITTED_VISUALLY`, `CHECKIN_REVERSED`, and for
offline `OFFLINE_CHECKIN_RECONCILED`; the "Recent scans" list; the supervisor's notes on every duplicate or
wrong-show case; the final attended count against tickets sold.

---

## 5. Refunds and cancellations

### 5.1 Customer cancels before paying

A buyer can cancel only their own `PENDING_PAYMENT` booking (`POST /bookings/:id/cancel`). The hold also
expires by itself. Staff cannot cancel a customer's unpaid booking (it was removed in #321); tell the buyer to
wait for the hold to expire (G13).

### 5.2 Customer asks for a refund after paying

**Who decides.** The organizer owner (organizer console `/organizer/refunds`, "Refund" or "Decline") or
platform staff holding `REFUND_APPROVE` (admin console Refunds, "Approve & refund" or "Reject"). A
`REFUND_DESK` user can read but cannot decide; the buttons show for them and the API answers 403.

1. **Buyer requests** from My bookings: "Request a refund" with a reason of 3 to 500 characters. Rules in
   `RefundsService.request`:
   - The booking must be `CONFIRMED` or `PARTIALLY_REFUNDED`.
   - The event must offer refunds and the request must be before the cutoff (default 48 hours before start;
     0 means up to the start).
   - Cash bookings are refused online.
   - Only ticket value plus tax added on top is refundable. **Booking and payment fees are not returned**
     on a buyer request.
   - A free booking has no refund. "Cancel tickets" cancels at once.
   - A guest buyer uses the emailed link and the email used for payment.
2. **Support** cannot raise a refund for the buyer. Staff requests are refused and audited
   (`refund.request-for-customer`). Ask the buyer to request it, or ask the organizer owner.
3. **Reviewer** opens Refunds (`/admin/refunds`, "Waiting for a decision") and opens the request. Check:
   booking is the buyer's, tickets are not already used, the reason is believable, the amount equals the
   expected figure, and the event's refund policy allows it.
4. **Decide.**
   - Approve: sends the refund to the original payment method through the gateway that took it, cancels
     the tickets, returns stock, issues a credit note and emails the buyer.
   - Reject: no money moves. Write a reason in the case notes.
5. **Check the result.** Status goes `REQUESTED` > `PROCESSING` > `COMPLETED`. Razorpay is `COMPLETED` only
   when the gateway says `processed`; the `refund.processed` webhook finishes a `PROCESSING` row.
6. **Checked-in tickets** are still refundable inside the window. The reviewer decides.

### 5.3 Failed refunds

There are two kinds, and they need different handling (`refunds.service.ts`, `razorpay-webhook.processor.ts`).

| Kind                         | What the console shows                                                                  | Tickets                                    | Action                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Refused when approving       | Refund `FAILED`; "The payment provider refused this refund. No tickets were cancelled." | Still active.                              | Find the reason in the Razorpay dashboard. The buyer can request again. There is no retry button (G14). |
| Failed later at the provider | Refund `FAILED`, audit `REFUND_FAILED_AT_PROVIDER`                                      | **Already refunded; seats may be resold.** | Pay the buyer out of band, record who paid, how and when in the case notes, and tell Finance.           |

Either way, escalate to Finance the same day and list it in the daily checklist (section 10). Never assume a
refund succeeded.

### 5.4 Organizer cancels a show or event

- Cancelling a **show** (`POST /shows/:sessionId/cancel`, cinema schedule screen) expires unpaid bookings and
  opens a `REQUESTED` refund for every paid booking, for the full amount paid including fees. A person still
  approves each one. The sweep that opens them runs about every 2 minutes. **The dialog text says nobody is
  refunded; that text is out of date (G15).** Tell the organizer the refunds are opened and need approval.
- For a **GA event outside a cinema** there is no organizer-facing cancel in the API I found (G3). The pilot
  procedure: the organizer tells support in writing; a reviewer with `EVENT_REVIEW` presses "Cancel event"
  (stops sales); then each paid booking is refunded one by one through section 5.2, on the organizer
  owner's written authority; the refund reason says "Event cancelled by organizer". Count the bookings from
  Bookings before and after so none is missed.
- Tell buyers by email using the incident template in section 9, because the platform does not email them for
  an event-level cancel.

### 5.5 Refund after the organizer has been paid

A refund on a settled amount reduces the next payout. If the payout is already marked `PAID`, the money has
left. Finance records it as a negative amount on the next payout (a negative net is recorded regardless of
the minimum) or collects it from the organizer. There is no automatic clawback for the manual bank path.

### Evidence to keep

Audit rows `REFUND_REQUESTED`, `REFUND_COMPLETED`, `REFUND_REJECTED`, `REFUND_FAILED`,
`REFUND_FAILED_AT_PROVIDER`; the credit note number; the gateway refund id; for any out-of-band payment, the
bank reference.

---

## 6. Customer support escalation

### What support can and cannot do (#321)

- **Can:** read any booking, payment and ticket summary in the admin console (Bookings, Payments, Accounts;
  needs `BOOKING_READ`); read the organizer's status (`ORGANIZER_READ`); change a support message's status
  (`SUPPORT_MANAGE`: OPEN > TRIAGED > CLOSED) in "Support & complaints".
- **Cannot:** buy for a customer, pay, cancel an unpaid booking, request a refund, view or resend a ticket's
  QR, transfer or reassign a ticket, change attendee details, or approve a refund (without `REFUND_APPROVE`).
  Staff get a refusal on all of the customer routes (`docs/security/ADMIN-PERMISSION-MATRIX.md`, "Customer
  resources: platform staff").
- **Result:** support helps a buyer by telling them what to do, and by asking the organizer owner to act, not
  by acting in the buyer's account. Staff reading a booking is audited.
- **A ticket that cannot be resent by staff.** If a buyer lost the email, they sign in and open My bookings,
  or a guest uses the link. If neither works, escalate to Tier 2.

### Tiers and targets

The targets are from `docs/reports/SUPPORT-PLAN.md`, `SUPPORT-PLAYBOOK.md` and `ESCALATION-MATRIX.md` and are not contractual.
Nothing in the product tracks them (G16): no due date or timer exists on a support item, and support hours
are not published (`BUSINESS_DETAILS.supportHours` is null).

| Tier | Who                            | Handles                                                                        | First response                       |
| ---- | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| 1    | Support duty                   | Order lookups, how-to, "where is my ticket", refund requests (guide the buyer) | 4 business hours                     |
| 2    | Finance duty / organizer owner | Refund decisions, failed refunds, payout questions, organizer disputes         | 4 business hours, same day for money |
| 3    | Engineer on call               | Charged but no ticket, double charge, gate down, data problems                 | 15 minutes (SEV1), 1 hour (SEV2)     |
| 4    | Program owner                  | Policy, legal, public statements, security                                     | Same business day                    |

### Steps

1. **Intake.** Messages arrive in the admin console "Support & complaints" (`/admin/support`), submitted
   from the storefront contact form or the organizer "Send feedback" box. **Nobody is emailed when one
   arrives (G17).** Someone must open the inbox at fixed times (section 10).
2. **Triage.** Read the message. Set the status to TRIAGED when you have taken it.
3. **Look up** the booking by reference in Bookings. Note the payment status, the ticket status and any
   refund.
4. **Answer** from the pilot support address. Today the organizer help page has no published support email
   (`BUSINESS_DETAILS.organizerEmail` is null) and the customer address is `support@eticketsgo.com`. **VERIFY
   LIVE** that this mailbox is staffed before the pilot (G16).
5. **Escalate** by tier above, writing the booking reference, what the buyer said and what you checked.
6. **Close** the item only after the buyer has the answer. Complaints against an organizer also show on the
   organizer's detail page ("open complaints").
7. **Never ask for or accept** a buyer's card details, OTP or password.

---

## 7. Maker-checker staffing: what the owner must grant

**Nothing in this section has been granted.** The owner (a super admin holding `ADMIN_MANAGE`) grants each
duty in the admin console: Staff & duties > "Add back-office staff" (creates a one-time invitation link that
expires in 7 days, `inviteStaff`) or "Duties" on an existing person (`PUT /admin/staff/:userId/permissions`).
Presets are shorthand applied at assignment time (`ADMIN_PRESETS`, `packages/shared-types/src/admin-permissions.ts`).

### What the code enforces

1. **Bank details are saved only by the organization's owner**, never by platform staff
   (`POST /payouts/accounts`, `@OrganizerOnly('payout.account.save')`). So the maker is always the organizer.
2. **Bank details are checked by staff holding `PAYOUT_MANAGE`** (`POST /admin/payouts/accounts/:id/verified`
   and `/reject`). The code refuses a checker who entered the details or who is a member of that
   organization (`independenceFailure`). Both refusals are audited as `PAYOUT_ACCOUNT_VERIFIED` with outcome
   `REFUSED`.
3. **A payout cannot be marked PAID** for a net amount above zero unless the INR account exists, is
   verified in its **current version**, and was not rejected (`payoutDestinationVerdict`). Saving new details
   resets verification, so a changed account holds all its payouts.
4. **The checker decides on the version it saw.** If the owner saved something else, the check is refused.

### What the code does NOT enforce (policy has to)

- **The person who verifies an account and the person who marks its payout paid may be the same staff
  member.** One capability, `PAYOUT_MANAGE`, covers verify, reject, reveal, mark paid, mark failed, payout
  settings and settlements (G1). One person holding it can verify and pay.
- A super admin holds every capability by role and passes every check. A single super admin therefore
  operates the whole money path alone.
- A staff member who belongs to a pilot organization cannot verify its bank account, but nothing stops one
  being made a member. Do not add staff to pilot organizations.

### Minimum staffing the owner must grant

Three named people plus the owner. The owner stays a break-glass account and does not do daily work.

| Seat                 | Person (owner fills in) | Preset to assign                                             | Exact capabilities                                                                                                                               | Duties in this document                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Finance A (checker)  | _TBD_                   | FINANCE                                                      | `BOOKING_READ`, `FINANCE_READ`, `REFUND_REVIEW`, `REFUND_APPROVE`, `PAYOUT_MANAGE`, `FINANCE_APPROVE`, `FINANCE_RESOLVE`, `PLATFORM_CONFIG_READ` | Verifies or rejects bank accounts; reveals account numbers; reconciliation. |
| Finance B (payer)    | _TBD_                   | FINANCE                                                      | Same eight capabilities as Finance A                                                                                                             | Records payouts as paid or failed; approves refunds; reconciliation.        |
| Reviewer and support | _TBD_                   | MODERATOR + SUPPORT, and OPERATIONS if one person covers all | `ORGANIZER_READ`, `ORGANIZER_REVIEW`, `EVENT_REVIEW`, `BOOKING_READ`, `SUPPORT_MANAGE` (+ `OPS_READ`, `OPS_EXECUTE` for OPERATIONS)              | Approves organizers and events; support inbox; ops health.                  |

Notes for the owner:

- **Why two Finance seats.** Two independent people must each hold `PAYOUT_MANAGE` so that Finance A checks a
  bank account and Finance B pays against it, and so that one person's absence does not stop payouts. This is
  a **procedure** (rule P1 below), not a code control (G1).
- **Do not give `PLATFORM_CONFIG`, `PAYMENT_ADMIN` or `ADMIN_MANAGE`** to any of the three. They change fees,
  payment providers and who has access, and no preset carries them.
- **Do not give the Reviewer seat `PAYOUT_MANAGE`.** The person who approves an organizer must not also
  verify that organizer's bank account.
- **Smaller grants are possible.** A checker needs only `PAYOUT_MANAGE` to act, plus `BOOKING_READ` for the
  audit log and `FINANCE_READ` to see the reports. The FINANCE preset is shown because it is the owner's
  approved bundle. A custom set is the owner's choice.
- **The admin console shows pages only to people holding the page's capability.** The Payouts page needs
  `PAYOUT_MANAGE`; Organizers needs `ORGANIZER_REVIEW`; Refunds needs `REFUND_REVIEW`; Finance
  reconciliation needs `FINANCE_READ`; Operations needs `OPS_READ`; Audit log needs `BOOKING_READ`.
- **Existing accounts keep what they hold.** Editing a preset changes nothing for someone already granted.
  A note dated 2026-10-10 says QA still served older presets. **VERIFY LIVE** with Staff & duties after the
  grant, by opening each person's duties.

### Procedural rules (write these into the staff briefing)

- **P1.** The staff member who presses "Mark checked" for an organizer's account must not press "Mark paid"
  for that organizer's **first** payout. Finance B pays. If only one is available, the owner approves in
  writing before the payment is recorded.
- **P2.** Revealing an account number ("Show number") is done by the person about to transfer, with a reason
  such as "Payout for <organizer> <date>". Never type the number in the reason.
- **P3.** Staff are never members of pilot organizations and never use a customer account for work.
- **P4.** The owner reviews the Audit log filtered to `PAYOUT_ACCOUNT_VERIFIED`, `PAYOUT_ACCOUNT_REVEALED`
  and `PAYOUT_PAID` every week and signs the check (section 10).
- **P5.** Each person uses their own login. Shared logins break the independence checks.

---

## 8. Payout bank verification (maker-checker)

**Maker.** The organizer's owner. **Checker.** Finance A. **Where.** Organizer console `/organizer/payouts`
("Bank account") and admin console Payouts > "Bank accounts" card.

### Steps

1. **Organizer enters details.** Fields: "Currency this account receives" (INR), "Account holder name",
   "Bank name", "IFSC, routing number or SWIFT", "Account number" (6 to 20 digits). The number is stored
   encrypted and never shown back in full. Status shows "Waiting for verification". The owners are emailed.
   **VERIFY LIVE:** the environment has `PAYOUT_BANK_ENCRYPTION_KEY` set; without it the save is refused
   ("Bank details cannot be stored on this environment yet").
2. **Checker opens** Payouts > "Bank accounts". Each row shows organizer, currency, holder, bank, IFSC,
   last four digits, version and "Entered by <email>".
3. **Checker verifies the details against an outside document.** Acceptable evidence, in order:
   - a cancelled cheque or a bank statement header sent by the organizer, or
   - a penny-drop test transfer that the bank confirms with the holder name.
     Check: holder name equals the organization's registered legal name (or the owner's name for a sole
     proprietor, with the organizer's written explanation); IFSC belongs to the named bank; last four digits
     match; the account is a current or savings account in India in INR.
     To see the full number, press "Show number", type a reason, and press "Show it". The reveal is audited
     (`PAYOUT_ACCOUNT_REVEALED`).
4. **Checker decides.**
   - "Mark checked": records the check and emails the owners ("Account marked as checked").
   - "Turn down": opens "Turn these details down?". Type "Why?" in words the organizer can act on, such as
     "Holder name does not match the registered name." The reason is emailed to the owners. Do not type any
     digits that look like an account number.
5. **If it is refused.** "You entered these bank details, so someone else must check them" or "You belong to
   this organization..." means the wrong person pressed it. "These bank details changed since you opened
   them. Reload and check them again." means the owner saved again; start over from the new version.
6. **After a turn-down** the organizer must save the details again. That starts version N+1 and a fresh check.
   The "History" button lists every version, who saved it and who decided.
7. **Changed account later.** Any change resets verification and holds that organizer's payouts until a new
   check. This is intended. Do not "Mark checked" without repeating step 3 for the new version.

### Evidence to keep

The document the organizer sent; the version number checked; the audit rows `PAYOUT_ACCOUNT_SAVED`,
`PAYOUT_ACCOUNT_VERIFIED` or `PAYOUT_ACCOUNT_REJECTED`; for a reveal, `PAYOUT_ACCOUNT_REVEALED` with the reason.

### Payout generation, hold and marking paid (Finance B)

1. **Hold.** Revenue becomes payable only when the event is `COMPLETED` or `ARCHIVED` and no session ended
   in the last hold period (default 7 days, `PAYOUT_HOLD_DAYS`; per-organizer terms in the "Settlement terms"
   card). CANCELLED events are excluded.
2. **Organizer raises the payout** at `/organizer/payouts` with "Generate settlement". An organizer owner or
   manager only. The result is a `PENDING` payout, one per currency. Refusals are explained in words: held
   until the event finishes (with the date), no new paid revenue, below the minimum payout, or an open payout
   already exists. Automatic runs are off unless "Settlement run: Automatically" is set for the organizer.
   Leave it off in the pilot.
3. **Finance B opens** Payouts > "Payouts" and filters the status. Check net payout against Finance
   reconciliation and the organizer's own Finance page ("Ready to pay out now").
4. **Finance B reveals the account number** ("Show number"), makes the bank transfer outside the platform,
   and notes the bank reference (UTR).
5. **Finance B presses "Mark paid"**, enters "Bank reference" (UTR) and a note, and presses "Confirm paid".
   If the account is not verified in its current version, the API answers "This payout is on hold" and
   writes `PAYOUT_PAID` with outcome `REFUSED`. A second press answers "Payout is already PAID."
6. **If the bank returns the money**, press "Returned by bank" or "Failed", type "What happened" and press
   "Record failure". The revenue rolls into the next payout.
7. **Never use** Settlements > "Release" in the pilot. It is refused while payout execution is off, and
   if it were on it could pay an organizer a second time on top of the manual payout.

---

## 9. Incident response

Severity levels follow `docs/pilot/INCIDENT-RESPONSE.md` and `ESCALATION-MATRIX.md`: SEV1 page now, SEV2 within
1 hour, SEV3 next business day. Other documents use "P0", "page" or "P1"; map them as P0 and page to SEV1. The
review is due within 48 hours (`docs/launch/INCIDENT-RESPONSE.md`; a longer 3-business-day figure appears
in `docs/ops/DISASTER-RECOVERY.md`, so use the shorter).

| Level | Pilot examples                                                                                                                           | Respond           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| SEV1  | Buyer charged with no ticket; double charge or refund; checkout down; gate cannot scan at a live event; data exposure; wrong money moved | Page on-call now  |
| SEV2  | Slow or erroring API with a workaround; one email type failing; queue backlog; a refund `FAILED`                                         | 1 hour            |
| SEV3  | Single-user problem with a workaround; wording                                                                                           | Next business day |

### Roles

Incident commander (Program owner by default), on-call engineer, finance, support, comms. Fill the names in
`ESCALATION-MATRIX.md`. It is a blank template today (G18).

### Payment incident

1. **Stop the loss.** If buyers can be charged without tickets, an admin with `PLATFORM_CONFIG` turns on
   Operations > "Maintenance mode" (this blocks the whole storefront; the finer payment suspend controls are
   API-only under `/admin/payments/outage`, `PAYMENT_ADMIN`, G19).
2. **Preserve evidence.** Note the booking references, payment ids, times and the Razorpay dashboard state.
   Do not retry or refund until Finance has looked at the Razorpay payment.
3. **Check the safety net.** A paid booking should never be released as abandoned
   (`pending-payment-recovery.service.ts`). Audit rows `PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING` and
   `PAYMENT_DUPLICATE_CAPTURE` say "refund manually". Signature-rejected webhooks return 400
   `PAYMENT_WEBHOOK_INVALID`; **VERIFY LIVE** that the webhook secret matches (on 2026-10-06 it did not, and
   a real payment was captured and not confirmed; `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`).
4. **Fix the buyer** first: confirm the booking and email the ticket, or refund through section 5.
5. **Record** a note: timeline, who decided what, amounts, buyers affected.

### Data incident

Suspected exposure of personal or bank data: SEV1. Stop sharing the affected export; revoke the staff access
involved (owner, Staff & duties > remove access); preserve the Audit log (it cannot be edited); notify the
Program owner and the Security Contact at once; decide on notifying affected people and regulators with the
owner. Reveals of account numbers are listed by `PAYOUT_ACCOUNT_REVEALED`.

### Rollback trigger

No numeric rollback trigger exists in the repository (G20). Pilot rule, to be ratified by the owner: roll back
the last deployment if, within 30 minutes of a release, checkout or ticket delivery errors for two buyers in
a row, or any SEV1 starts that was not present before. Production deploys are the owner's action. Follow
`docs/release/ROLLBACK-CHECKLIST.md` (not reviewed for this document). A Railway variable change redeploys the
latest main, so never change a variable to "test" something.

### Communications

Use the three templates in `docs/launch/INCIDENT-RESPONSE.md` (Investigating, Identified or mitigating,
Resolved). Rules: say what buyers should do; give no cause until known; send updates every 30 minutes for a
SEV1; email is the only buyer channel that works (SMS, WhatsApp and push are in log mode; the 2026-10-04
production note says so, **VERIFY LIVE**). Tell organizers by email and phone.

---

## 10. Pilot daily and weekly checklist

Record each tick, the person, the time and any reference in the pilot log. Daily items run in the morning
and again an hour before any live event.

### Daily

| #   | Check                                                                                                                                                                                                        | Where                                     | Who       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------- |
| D1  | Platform health is green: database up, redis up, queue not degraded. `appEnv` shows the right environment.                                                                                                   | Operations > "System health"              | Ops       |
| D2  | Failed jobs: "Queue health - holds" Failed count. Only failures in the last 24 hours degrade the queue. Retry only after reading why.                                                                        | Operations                                | Ops       |
| D3  | Webhooks: no signature failures (`payment_webhooks{result="signature_invalid"}`, no alert exists, G21). Ask the on-call to check logs.                                                                       | Logs, on-call                             | On-call   |
| D4  | Reconciliation: press "Run detection", then work every OPEN item to RESOLVED or IGNORED with a reason.                                                                                                       | Finance reconciliation                    | Finance   |
| D5  | Payments with no booking, or bookings paid with no ticket: any `PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING` or `PAYMENT_DUPLICATE_CAPTURE` in the Audit log since yesterday.                                      | Audit log                                 | Finance   |
| D6  | Refunds waiting: open "Waiting for a decision". Target: none older than one business day. Any `FAILED` listed with owner and next step.                                                                      | Refunds                                   | Finance   |
| D7  | Support inbox: every OPEN item is TRIAGED or answered. Nobody is notified automatically (G17).                                                                                                               | Support & complaints                      | Support   |
| D8  | Event approval queue: nothing waiting more than one business day.                                                                                                                                            | Events > Approval queue                   | Reviewer  |
| D9  | Organizer applications waiting.                                                                                                                                                                              | Organizers (status filter "Pending")      | Reviewer  |
| D10 | Held payouts: any `PAYOUT_PAID` audit row with outcome `REFUSED`. Each is a bank account that needs a check or a turn-down.                                                                                  | Audit log, Payouts                        | Finance A |
| D11 | Bank accounts "Waiting for verification" older than one business day.                                                                                                                                        | Payouts > Bank accounts                   | Finance A |
| D12 | Failed notifications: no console screen exists (G22). Ask the on-call to query the notification list (`GET /api/admin/notifications` with `status` filter, `OPS_READ`) for failures and for `configBlocked`. | API                                       | On-call   |
| D13 | Live-event day: confirm the gate staff each scanned a test ticket on the real phone. Confirm the on-call engineer is named.                                                                                  | Gate screen                               | Organizer |
| D14 | Backup freshness: a verified dump from the last 24 hours exists. See below.                                                                                                                                  | Railway / `run-seed-operation.mjs status` | On-call   |

**Backups (D14).** The design is a nightly verified `pg_dump` at 02:00 with 14 recovery points
(`docs/ops/BACKUP-RUNBOOK.md`, `apps/api/prisma/backup.ts`). Its own notes say a green job once took no backup
for five nights, that Railway platform backups need an owner dashboard action, that no off-platform copy
exists and that no production restore has been rehearsed (`docs/ops/PRODUCTION-READINESS-2026-10.md`,
rows 3 to 5, dated 2026-10-04). **VERIFY LIVE** before the pilot starts and treat "a backup you cannot list"
as no backup. Do not start the pilot without one (G23).

### Weekly (Monday)

| #   | Check                                                                                                                                                                                                                                   | Who           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| W1  | Reconciliation aging: nothing in the "7-30d" or "30d+" buckets without an owner.                                                                                                                                                        | Finance       |
| W2  | Audit review: filter `PAYOUT_ACCOUNT_VERIFIED`, `PAYOUT_ACCOUNT_REVEALED`, `PAYOUT_PAID`, `EVENT_AUTO_APPROVED`, `ORG_AUTO_APPROVE_ENABLED`, `ADMIN_PERMISSIONS_CHANGED`. The owner signs it. Any `EVENT_AUTO_APPROVED` is an incident. | Owner         |
| W3  | Payout run: list payouts `PENDING`; match each net figure to the organizer's Finance page; pay per section 8.                                                                                                                           | Finance B     |
| W4  | Each PAID payout has a bank reference; each reference appears on the bank statement.                                                                                                                                                    | Finance A     |
| W5  | Restore drill result from the last 7 days (`restore-drill`).                                                                                                                                                                            | On-call       |
| W6  | Staff list: every person still needs their access (Staff & duties). Remove leavers.                                                                                                                                                     | Owner         |
| W7  | Support: count of items, slowest response, repeat causes; feed fixes to the product backlog.                                                                                                                                            | Support       |
| W8  | Pilot scorecard: events run, tickets sold, refunds, incidents, organizer complaints.                                                                                                                                                    | Program owner |

---

## 11. Documents that disagree with the code (fix when convenient)

- `docs/security/ADMIN-PERMISSION-MATRIX.md` lists ops queue retry and support status change as "none today"
  for audit. The code writes `OPS_QUEUE_RETRY_ALL`, `OPS_QUEUE_RETRY_JOB` and `SUPPORT_TICKET_STATUS_CHANGED`.
- `docs/REFUND_POLICY_PROPOSAL.md` says nothing is automatic on cancellation; the code opens refunds.
- `docs/payments/INDIA-PAYMENTS-RUNBOOK.md` line 65 lists `refund.failed` as ignored; the code handles it.
- The organizer "Cancel show" dialogs say nobody is refunded (see G15).
- `docs/ops/DISASTER-RECOVERY.md` assumes point-in-time recovery that Railway does not provide.

## 12. Product gaps found that block or weaken a procedure

| #   | Gap                                                                                                                                                                                           | Blocks or weakens                             | Severity for the pilot                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| G1  | One capability (`PAYOUT_MANAGE`) covers verify, reveal, pay and settlements, and nothing stops the same person verifying an account and paying against it. Super admin does everything alone. | Section 7, section 8 (independence of paying) | Must be covered by procedure P1 or fixed in code |
| G2  | Invited check-in staff keep `User.roles = [CUSTOMER]` and the check-in controller checks that global role. Unverified on any environment.                                                     | Section 4 (gate staff)                        | Must be tested before the first event            |
| G3  | No event-level cancel for organizers; admin "Cancel event" opens no refunds and cancels no sessions.                                                                                          | Section 5.4                                   | Manual procedure only                            |
| G4  | Offline check-in is behind `OFFLINE_CHECKIN_ENABLED` (off by default). The gate screen promises offline queueing but has none; only the full check-in page queues.                            | Section 4                                     | Use online scanning                              |
| G5  | A `PENDING` or `REJECTED` organizer can create events and submit them; there is no organization status check.                                                                                 | Section 1                                     | Review step is the only gate                     |
| G6  | No launch-market switch: an organizer in any supported country can register.                                                                                                                  | Section 1                                     | Human check                                      |
| G7  | The console cannot send `overrideIdentityCheck`, and the review-signals endpoint has no screen.                                                                                               | Section 1                                     | Low                                              |
| G8  | An event rejection reason is optional.                                                                                                                                                        | Section 2                                     | Low (rule)                                       |
| G9  | No sales-window inputs in the console.                                                                                                                                                        | Section 3                                     | Low                                              |
| G10 | The gate screen has no tile for `EXTERNAL`.                                                                                                                                                   | Section 4                                     | None for GA                                      |
| G11 | The gate screen shows every API error, including network loss, as "Not valid".                                                                                                                | Section 4                                     | Medium on poor signal                            |
| G12 | Revoking an offline device does not stop that person scanning online.                                                                                                                         | Section 4                                     | Low                                              |
| G13 | Staff cannot cancel a customer's unpaid booking (by design after #321).                                                                                                                       | Section 5.1                                   | Low                                              |
| G14 | No retry or re-approve for a `FAILED` refund; failures after the provider accepted need a manual payment.                                                                                     | Section 5.3                                   | Medium: needs Finance owner                      |
| G15 | Organizer cancel-show dialogs say nobody is refunded, but refunds are opened automatically.                                                                                                   | Section 5.4                                   | Medium (misleads organizers)                     |
| G16 | No support timers, no published support hours, no organizer support email in the product.                                                                                                     | Section 6                                     | Fill before the pilot                            |
| G17 | A new support message notifies nobody.                                                                                                                                                        | Section 6, D7                                 | Daily inbox check is the control                 |
| G18 | `ESCALATION-MATRIX.md` roster is blank.                                                                                                                                                       | Section 9                                     | Must be filled                                   |
| G19 | Payment outage controls have no admin screen; "payment maintenance" is the same flag as the whole-site maintenance.                                                                           | Section 9                                     | Needs the on-call engineer                       |
| G20 | No numeric rollback trigger in the repository.                                                                                                                                                | Section 9                                     | Owner to ratify the pilot rule                   |
| G21 | No alert rules exist (`PRODUCTION-READINESS-2026-10.md` row 17, a 2026-10-04 note).                                                                                                           | D3                                            | Daily manual check                               |
| G22 | No screen shows failed notification deliveries; the organizer notifications page is an alert feed, not a delivery log.                                                                        | D12                                           | API check only                                   |
| G23 | Backups: no demonstrated current production backup or restore (note dated 2026-10-04).                                                                                                        | D14                                           | Re-verify; blocks go-live if unproven            |
