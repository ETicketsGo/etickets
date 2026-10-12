# India pilot playbook: 3 to 5 organizers, about 10 general-admission events

Prepared 2026-10-12 from `origin/main 3ef1b51d`. Scope: INR through Razorpay, general admission (GA) only,
email as the only buyer channel. Regulated cinema ticketing stays OFF. Production stays NO-GO (see
`PILOT-READINESS.md`); this playbook says how to RUN the pilot once the owner actions there are done. It
does not change that verdict.

## How to read this

- This builds on, and does not repeat, `OPERATING-PROCEDURES.md` (referred to as **OP**, with its gap numbers
  G1 to G23), `PILOT-JOURNEY.md`, `INDIA-COMMUNICATIONS.md`, `RAZORPAY-READINESS.md`, `INFRASTRUCTURE.md`,
  `ESCALATION-MATRIX.md`, `INCIDENT-RESPONSE.md`, `SUPPORT-PLAYBOOK.md`, `LAUNCH-CHECKLIST.md`, `PILOT-GUIDE.md`
  and `PILOT-READINESS.md`. Where this page decides something, it says so. Where an older page is wrong, section
  13 lists it.
- Evidence labels: **[code]** read at `3ef1b51d` (file and line given); **[QA 2026-10-12]** a read-only call to
  QA as `admin@eticketsgo.test`; **[doc]** a statement in another document that I did not re-verify;
  **[assumption]** a planning figure that nothing in the repository measures. Assumptions are flagged so they
  get replaced with measured numbers after the first event.
- **LEGAL REVIEW** marks an item that needs a lawyer or an accountant. Engineering wrote the drafts; nothing
  marked this way is advice.
- **OWNER** marks something only the owner (or a person the owner names) can do. Nothing in this document
  grants a permission or changes a setting.
- Names, phone numbers and rota times are left as blanks on purpose. Nobody has been named
  (`ESCALATION-MATRIX.md` section 1 is still a blank template, OP gap G18).

---

## 1. Organizer onboarding and the organizer agreement

### 1.1 Selection (before anyone registers)

Pick 3 to 5 organizers. Each must meet all of these; the program owner records the answer in the pilot folder
(outside the repository):

| Test                                        | Why                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Registered in India, with a legal name      | The approval check needs legal name, entity type and country (OP section 1) [code] |
| Events are GA, paid or free, in INR         | Seated and cinema events are out of scope (OP ground rule 1)                       |
| Venue and city are in India, none in cinema | The venue country decides the currency; Telangana cinema sales stay restricted     |
| Can attend a 30-minute walkthrough          | Organizers run the gate and the refund queue themselves                            |
| Has a bank account in its legal name        | Payouts go only to a verified account in the organization's name (OP section 8)    |
| Expected attendance per event is known      | Needed for gate staffing (section 5)                                               |

Spread the 10 events over at least 2 weekends. Do not put the first event of every organizer on the same day:
one on-call engineer cannot cover several gates (section 8).

### 1.2 Steps

Follow OP section 1 for the screens, the reviewer checks and the evidence to keep. Add these pilot steps around it:

1. **Before registering:** the organizer receives the agreement text (1.3), the `ORGANIZER-GUIDE.md`, and the
   refund and cancellation rules (section 4). The program owner records the acceptance by email. **The product
   does not record it** (1.4).
2. **Registration, details and bank account:** as OP section 1 and section 8. The organizer's owner saves the
   bank account; a different person verifies it. [code]
3. **Walkthrough** (30 minutes, screen share): create a free test event on the organizer's own account, submit
   it, watch the reviewer approve it, scan one test ticket with the gate screen, then cancel the test.
   A free event skips payment entirely (OP section 2). This is the one rehearsal every organizer gets.
4. **Contact sheet:** the organizer gives a named event-day contact with a mobile number, and a finance contact.
   Both go on the escalation sheet (section 3).
5. **Go-live note:** the reviewer approves the organization (OP section 1) only after steps 1 to 4 are filed.

### 1.3 What the organizer agreement must cover

**LEGAL REVIEW for the whole of this section.** A draft exists at `docs/commercial/ORGANIZER-AGREEMENT.md` and as
a public page at `apps/customer-web/app/[locale]/organizer-agreement/page.tsx` (marked `robots: noindex`). Both
declare themselves a draft. The draft leaves these as "to be defined": payout schedule and reserves, notice and
cure periods and the effect of suspension on pending payouts, tax responsibility, and liability and indemnity
(section 8 of the draft is empty) [code]. The pilot agreement must settle each of the following. The right-hand
column is what the PRODUCT does today, so counsel drafts terms that match behaviour.

| Topic                               | The agreement must say                                                                                                         | What the product does today [code]                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fees                                | Booking fee, payment fee, GST on fees, who bears them (the organizer's fee mode), and that fees can change                     | Fee bands are configuration; the organizer picks "customer pays", "organizer pays" or "shared". Fee refund rule: section 4                                                                                                                                                       |
| Payout terms                        | Currency (INR), schedule, minimum payout, bank account rules, who may change the account, how a returned payout is handled     | Manual bank transfer by staff, outside the platform (OP ground rule 3). Default hold 7 days after the last session ends (`PAYOUT_HOLD_DAYS`, `config/configuration.ts:157`). A changed bank account re-holds all payouts (OP section 7)                                          |
| Payout hold and reserve             | Whether the platform may hold more than the default, for how long, and why (disputes, fraud, cancellation)                     | The hold is per organizer in "Settlement terms". No rolling reserve exists for the manual path                                                                                                                                                                                   |
| Refunds and cancellation liability  | The organizer sets the refund policy per event; who pays when the organizer cancels; whether platform fees are returned        | Buyer self-service refunds return ticket value plus tax added on top, not fees. Organizer-cancelled shows refund the full amount paid including fees (OP section 5)                                                                                                              |
| Negative balances                   | The right to net refunds against later payouts and to recover a negative balance from the organizer                            | A refund after payout becomes a negative amount on the next payout; there is no automatic clawback (OP section 5.5)                                                                                                                                                              |
| Chargebacks                         | Who bears a chargeback and its fee; the organizer cooperates with evidence by the deadline                                     | Razorpay `payment.dispute.*` events are mirrored; open disputes show at `GET /api/admin/disputes` (`FINANCE_READ`). Evidence is submitted in the Razorpay dashboard by a person. [code: `razorpay-webhook.processor.ts:208`, `dispute.controller.ts`]                            |
| Data protection (DPDP)              | Roles of the platform and organizer for attendee data, purposes, retention, breach notice, grievance contact                   | Organizers see attendee name and booking details for their events; gate staff see less (OP section 4). The organization record has grievance-officer fields. The privacy policy is a draft (`docs/commercial/PRIVACY-POLICY.md`)                                                 |
| Content and age rules               | Truthful listing, no copied artwork, no unlawful content, age limit is stated and enforced at the door                         | The reviewer checks title, image, description, age limit and terms before approval (OP section 2). The product does not check age at the door                                                                                                                                    |
| GST invoicing                       | Who is the supplier of the ticket, who issues the tax invoice for admission, who remits GST on admission, GST on platform fees | GST rules ship INACTIVE; production charged tax 0 on INR in the 2026-10 note. The open questions are in `docs/INDIA_LAUNCH_READINESS.md` (GST Q1, Q10) and `docs/INDIA_GST_BUSINESS_DECISIONS.md`. Activation raises the buyer total (`india-gst-activation-raises-prices` note) |
| Permits and licences                | The organizer holds every permit (venue, police, fire, music licensing, local entertainment duty) and bears the cost           | The platform checks none of these                                                                                                                                                                                                                                                |
| Suspension and termination          | Grounds, notice, what happens to pending payouts and to buyers                                                                 | Suspension stops checkout at once (OP section 1). Pending payouts are not automatically held on suspension                                                                                                                                                                       |
| Event cancellation by the organizer | Written notice to support; the organizer authorises refunds; buyers are emailed by the platform or the organizer               | No organizer self-service cancel for a GA event (OP gap G3, section 4 here)                                                                                                                                                                                                      |
| Liability and indemnity             | Caps, indemnity for event-level claims (injury, crowd, cancellation)                                                           | Section 8 of the draft is empty                                                                                                                                                                                                                                                  |
| Acceptance                          | How and when the organizer agrees; version of the text                                                                         | See 1.4                                                                                                                                                                                                                                                                          |

Also **LEGAL REVIEW:** whether collecting buyers' money into the platform's Razorpay account and paying
organizers later by bank transfer falls under any payment-aggregator or escrow rule. `RAZORPAY-READINESS.md` and
the repository say nothing about this. Ask counsel before the first payout.

### 1.4 What the product does not do

- **No in-product acceptance.** The organizer sign-up form has no agreement tick or version record
  (`apps/organizer-web/app/start/page.tsx` mentions no terms; the only `termsAcceptedAt` in the schema belongs to
  payment-provider merchant onboarding, `merchant-onboarding.service.ts:127`) [code]. The pilot rule is a signed
  or emailed acceptance filed per organizer, dated, naming the version of the text. Engineering item for after
  the pilot: record acceptance and version at registration.
- **The public agreement page is a draft** and is linked from the storefront footer. **OWNER:** decide whether it
  stays public while it still says "to be defined".
- **No organizer support email is published** (`organizerEmail: null`, `packages/web-kit/src/business-details.ts:60`).
  Give each organizer the pilot support contact directly.

---

## 2. Event approval and verification checklist

The screens and steps are OP section 2 (queue, "Moderation" card, approve or reject) and section 3 (ticket
rules). Use this single checklist for every one of the 10 events; file a copy per event.

| #   | Check                                                                                                                    | Pass                                                           | Source of the fact                         |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------ |
| E1  | Organization is `APPROVED`, not suspended, legal identity complete                                                       | Standing card says so                                          | OP section 1                               |
| E2  | Agreement acceptance on file for this organizer                                                                          | Dated email, version named                                     | Section 1.4                                |
| E3  | Bank account for INR is "Verified" in its current version                                                                | Payouts > Bank accounts                                        | OP section 8                               |
| E4  | Session has no room or seat map (GA); no cinema; no regulated pricing                                                    | Admin event page "Sessions & tickets"                          | OP ground rule 1                           |
| E5  | Venue, city and date are real and in the future; venue is in India                                                       | Matches the organizer's permit or booking letter               | Human check                                |
| E6  | The organizer's proof of right to hold the event (venue booking, permit where one is needed)                             | Copy on file                                                   | LEGAL REVIEW: which permits apply per city |
| E7  | Title, description and image are truthful; no misleading claim; no copied artwork                                        | Reviewer reads all three                                       | OP section 2                               |
| E8  | Age limit, terms and artists present where they matter                                                                   | "Details" card                                                 | OP section 2                               |
| E9  | Each ticket price is in INR, matches the organizer's brief, above zero for a paid event                                  | "name - price x quantity" lines                                | OP section 3                               |
| E10 | "Quantity on sale" is what the organizer will sell, not the venue's capacity, and does not exceed the permitted capacity | Compare with the permit                                        | Human check                                |
| E11 | Fee handling is the one the organizer chose and was told about                                                           | "Fee handling" shows it                                        | OP section 2                               |
| E12 | Refund setting and cutoff match what the buyer will be told (default on, 48 hours before start)                          | "Refund settings"                                              | `schema.prisma:1371` [code]                |
| E13 | Free vs paid is declared correctly (a free event has price 0 on every ticket and the free flag)                          | Flag and prices agree                                          | OP section 2                               |
| E14 | The buyer total, with GST status checked, is what the organizer has been told                                            | Booking fees and Tax rules pages checked (GST may be inactive) | OP section 3, `india-gst` notes            |
| E15 | Gate plan exists: scanners named, invited and tested; staffing per section 5                                             | Test scan by each scanner on a free test ticket                | Section 5                                  |
| E16 | Event-day contact and on-call engineer named for the date                                                                | Written on the escalation sheet                                | Section 3, section 8                       |
| E17 | Auto-approve is OFF for the organization                                                                                 | "Publishing" card says every event waits for a reviewer        | OP section 2                               |

Reject with a written reason every time (the API does not require one; the pilot rule does, OP gap G8). Approve only
when E1 to E17 pass. Record the reviewer, the date and the audit row `EVENT_APPROVED`.

**Within 24 hours of the event:** the reviewer re-opens the page and re-checks E3, E5 and E9, because a bank
account change, a venue change or a price change after approval does not send the event back for review unless a
reviewed field changed (`ORGANIZER-GUIDE.md` section 5 describes which fields do) [doc].

---

## 3. Customer support and escalation

### 3.1 What exists

- **Customer address:** `support@eticketsgo.com` is the published support email
  (`business-details.ts:59`). **Support phone, support hours and organizer email are all null** (`:60`, `:64`,
  `:66`) [code]. The product publishes no hours.
- **In-product inbox:** the storefront contact form and help forms, the feedback widget and the organizer
  "Send feedback" box all post to `POST /api/support`; staff read them at `/admin/support`
  (`GET /api/admin/support`, `BOOKING_READ`) and set OPEN, TRIAGED or CLOSED (`PATCH /api/admin/support/:id`,
  `SUPPORT_MANAGE`) [code: `support/support.controller.ts:20-79`]. **Nobody is notified when a message
  arrives** (OP gap G17).
- **Timers:** none. No due date exists on a support item (OP gap G16).

### 3.2 Hours, channels, targets and owners for the pilot

The owner confirms or changes these. They are a proposal, not a measured service level.

| Item              | Proposal                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal hours      | 09:00 to 21:00 India time, every day of the pilot. **OWNER:** publish them (the product has none)                                                         |
| Event-day cover   | From 2 hours before doors until 1 hour after the last scheduled exit. One named person on the phone for the organizer; one on-call engineer               |
| Buyer channel     | Email `support@eticketsgo.com`, plus the contact form. Email is the only message channel that reaches buyers (SMS, WhatsApp and push are in log mode)     |
| Organizer channel | A phone number and a messaging group set up outside the product, owned by the program owner. The platform sends organizers email and in-app only          |
| Inbox check       | At the start of each normal-hours block, at midday and an hour before each event (OP D7). Because nothing notifies, an event-day person watches the inbox |
| Staff roster      | Support/reviewer seat: `MODERATOR` + `SUPPORT` presets. Finance A and B: `FINANCE` preset (OP section 7). Names: OWNER fills `ESCALATION-MATRIX.md`       |

| Priority | Examples                                                                                      | First response   | Target                         | Who                                      |
| -------- | --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------ | ---------------------------------------- |
| P1       | Charged and no ticket; checkout down; gate cannot scan at a live event; data exposure         | 15 minutes       | Mitigate at once; page on-call | On-call engineer + Finance + owner       |
| P2       | Slow or failing API with a workaround; one email type failing; refund `FAILED`; queue backlog | 1 hour           | Same business day              | On-call engineer, Admin                  |
| P3       | One buyer cannot find a ticket (has a workaround); refund question; organizer how-to          | 4 business hours | 2 business days                | Support, then Finance or organizer owner |
| P4       | Question, feature request, wording                                                            | 1 business day   | Backlog                        | Support                                  |

These match `SUPPORT-PLAYBOOK.md` section 4 and `ESCALATION-MATRIX.md` section 3 [doc]. Nothing in the product
tracks them: the daily report (section 9) records the oldest open item so a person does.

### 3.3 What support can and cannot do

OP section 6 is authoritative (#321): support reads bookings, payments and ticket summaries; support cannot buy,
pay, cancel an unpaid booking, request a refund, view or resend a QR, transfer a ticket or change attendee
details. A buyer who lost the email signs in and opens My bookings, or a guest uses the emailed link and the
reference (`guest-checkout` note; `GUEST_BOOKING_ACCESS` email, `notification-template.service.ts:241`). If
neither works, escalate to Tier 2.

**A buyer whose email bounced is stranded** (INDIA-COMMUNICATIONS section 6). Daily, the on-call person lists
failed or bounced booking emails: `GET /api/admin/notifications?channel=email&type=BOOKING_CONFIRMED&from=<day>`
and read each row's `deliveryState`. The `status` filter reads the notification's own status (SENT or FAILED), not
the delivery outcome: a permanent bounce moves it to FAILED, but a soft bounce stays SENT with `deliveryState`
`UNDELIVERED` (on QA, `status=UNDELIVERED` returned nothing while 72 of the last 100 rows had that delivery state).
So filter `status=FAILED` AND scan `deliveryState` for `BOUNCED`, `UNDELIVERED` and `COMPLAINED`. To start from a
buyer's complaint, add `reference=<booking reference>` (`OPS_READ`) [code: `notification-ops.controller.ts:46-79`,
`notification-ops.service.ts:78-91`; QA 2026-10-12]. Contact the buyer
through the organizer or the phone number on the booking if one exists, and ask for a working address.

### 3.4 Escalation path (fill the names)

1. Support (Tier 1) triages and writes the booking reference, what the buyer said and what was checked.
2. Money question or refund decision: Finance (Tier 2) the same day.
3. Charged but no ticket, double charge, gate down, data problem: on-call engineer (Tier 3), page now.
4. Policy, legal, public statement, security: program owner (Tier 4).
5. A security or data incident is SEV1 (OP section 9). Stop sharing the affected export first.

Escalation sheet to complete before the first event (one page, printed for each organizer's event contact):

| Role                | Name | Mobile | Backup |
| ------------------- | ---- | ------ | ------ |
| Program owner       |      |        |        |
| On-call engineer    |      |        |        |
| Finance A (checker) |      |        |        |
| Finance B (payer)   |      |        |        |
| Reviewer / support  |      |        |        |
| Security contact    |      |        |        |

---

## 4. Refunds and cancellations

The mechanics are OP section 5. These are the pilot decisions on top of them.

### 4.1 Customer refunds

- The organizer's per-event setting decides: refunds on or off, and a cutoff in hours before the start. The
  default is on with 48 hours (`schema.prisma:1369-1371`; `refunds.service.ts:332`). **`PILOT-GUIDE.md` and
  `SUPPORT-PLAYBOOK.md` say a fixed 48-hour rule; the code reads the event's own setting.** Tell each buyer the
  event's rule, not "48 hours".
- A buyer request returns ticket value plus any tax added on top. Booking and payment fees are not returned on
  a buyer request (OP section 5.2). **LEGAL REVIEW:** whether fees may be kept on a buyer-requested refund in
  India (GST Q9 in `docs/INDIA_LAUNCH_READINESS.md`).
- Who decides: the organizer's owner at `/organizer/refunds`, or staff with `REFUND_APPROVE`. Refunds are always a
  person's decision (`BOOKING_REFUND_POLICY_MODE` is `MANUAL_ONLY`, OP ground rule 4).
- **Pilot target:** no request waits more than one business day (OP D6). Finance lists every request older than
  one business day in the daily report.
- A free booking has no refund; "Cancel tickets" cancels at once.

### 4.2 Failed refunds

OP section 5.3 and gap G14. A refund that failed at the provider after the tickets were released needs a manual
payment from the Razorpay dashboard. Finance owns it, records who paid, how and when, and tells the buyer. Never
assume a refund succeeded: the status must read `COMPLETED`.

### 4.3 Organizer cancels an event

**Today there is no organizer screen for cancelling a GA event.** [code] The only cancel in the organizer console
is on the cinema schedule (`apps/organizer-web/app/organizer/cinemas/[id]/schedule/`); the API route
`POST /api/shows/:sessionId/cancel` exists for any session and is limited to members of the organization
(`shows.controller.ts:118`, `shows.service.ts:1657`), but no GA screen calls it. Admin "Cancel event" stops sales
and opens no refunds (OP gap G3). `PILOT-READINESS.md` section 4 says "cancel each show"; for a GA organizer
that means an engineer calling the API, not a button. Pilot procedure:

1. The organizer owner asks in writing (email) to cancel, and names the reason.
2. A reviewer with `EVENT_REVIEW` presses "Cancel event" to stop sales at once.
3. Count the confirmed bookings (Bookings, filter by event) before anything else.
4. Refund each paid booking through the normal refund path on the organizer owner's written authority, reason
   "Event cancelled by organizer". An organizer-cancelled show refunds the full amount paid including fees; keep
   to that so the buyer is whole. Alternatively ask engineering to cancel the session by API, which opens the
   refunds itself (a sweep about every 2 minutes) and emails buyers `SHOW_CANCELLED` (OP section 5.4).
5. Count again afterwards: bookings, refunds `COMPLETED`, refunds `FAILED`.
6. Email buyers directly if the session was not cancelled by API, because the platform does not email them for an
   event-level cancel.

**Cancellation liability** is the organizer's: the agreement (1.3) must say so, and say whether the platform's
fees are returned to the organizer (**LEGAL REVIEW**).

### 4.4 Refund after the organizer was paid

OP section 5.5: reduce the next payout, or collect from the organizer. The agreement must allow it (1.3).

---

## 5. Venue check-in staffing

### 5.1 Staffing rule

One scanner (a phone with a working camera and a charged battery, signed in beforehand) can clear a lane. The
figures below are a **planning assumption**, not measured: a staffed lane clears about 8 people a minute, and about
70% of attendees arrive in the 30 minutes before the start. Replace both numbers with measurements after event 1
(timestamps of `TICKET_CHECKED_IN` audit rows).

```
lanes  = ceil( 0.7 x expected attendance / 30 / 8 ), with a minimum of 1
people = lanes scanners + 1 supervisor, + 1 help desk when attendance is 300 or more
devices = lanes + 1 spare (charged, signed in, tested)
```

| Expected attendance | Lanes | People at the entry (scanners + supervisor + help desk) | Devices |
| ------------------- | ----- | ------------------------------------------------------- | ------- |
| up to 150           | 1     | 1 + 1 = 2                                               | 2       |
| 151 to 400          | 2     | 2 + 1 + 1 = 4                                           | 3       |
| 401 to 800          | 3     | 3 + 1 + 1 = 5                                           | 4       |
| 801 to 1,500        | 5     | 5 + 1 + 1 = 7                                           | 6       |

The pilot events should stay at or below 800 expected attendees; plan a separate review above that. For each
event the organizer lists the entries (doors) in use; the figures are PER ENTRY.

### 5.2 Invited gate staff (works since #338)

- The owner invites each person at `/organizer/team` > "Add someone" > role "Check-in staff". **The platform sends no
  email for this.** The console shows a link to copy and send; it works once and expires in 7 days
  (`organizations.service.ts:540-609` returns `inviteUrl`; no notification is created) [code]. Send the link by a
  channel you can confirm they received.
- Before #338 an invited scanner was refused because the route checked a global role the invited user did not
  have. #338 (merged, `49703ac5`) adds the roles of ACTIVE team seats to the request user in
  `auth/jwt.strategy.ts` [code]. The gate controller allows `CHECKIN_STAFF` (`checkins.controller.ts:33`).
- **Verify with a freshly invited account on QA before event 1, and again on production before the first real
  event.** I read the code; I did not invite anyone (QA writes were not in scope). Record: invited, accepted,
  signed in on the real phone, scanned one test ticket, result "Let them in".
- Revoking a device does not stop that person scanning online (OP gap G12); remove the team seat instead.

### 5.3 Devices and connectivity

- **Online scanning is the pilot method** (OP section 4). Offline check-in is behind `OFFLINE_CHECKIN_ENABLED`, off by
  default (OP gap G4). Do not plan on it.
- **Give each scanner its own mobile data. Do not put scanners on the venue's guest Wi-Fi.** The API throttles every
  caller by IP: 120 requests a minute by default (`app.module.ts:108`) and 10 a minute on sign-in and token refresh
  (`auth.controller.ts:52`) [code]. Several hundred guests on one venue Wi-Fi share one public IP, and their ticket
  loads and the scanners count against the same allowance. The gate screen shows every API error, including a
  refusal for too many requests, as "Not valid" (OP gap G11), so a throttled scanner looks like a run of bad tickets.
- Sign every scanner in at least an hour before doors, one at a time, not all at once at the entrance (the
  sign-in limit is per IP).
- Two network providers across the devices, a power bank per device, a printed fallback list (owner or manager
  exports it; check-in staff cannot) kept in a closed folder (OP section 4).
- The venue should have mobile coverage at the entry. Walk the entry with a scanner at the walkthrough.
- A scan error is not proof a ticket is false. Retry once, check the phone's signal, then call the supervisor.

### 5.4 Event-day procedure

Follow OP section 4 ("At the gate") and `CHECKIN-GUIDE.md`. Additions for the pilot:

1. T-24h: test scan by every scanner (free test ticket); on-call engineer confirmed (OP D13).
2. T-1h: health check (section 6.1), support inbox cleared, escalation sheet at the supervisor.
3. At doors: the supervisor counts scans each 30 minutes and compares with tickets sold.
4. Duplicate or wrong-session: supervisor decides; never un-check the first scan (OP section 4).
5. After the event: attended count against tickets sold goes into the daily report; the supervisor's notes on every
   duplicate or wrong-show case are filed.

Maintenance mode blocks check-in. See section 8.2.

---

## 6. Finance reconciliation and settlement

Procedures and staffing are OP sections 7, 8 and 10. This section is the order of work and the exact screens
and calls. Needs two named finance people (Finance A checks, Finance B pays); until they exist, no payout can be
completed (`PILOT-READINESS.md` owner action 9).

### 6.1 Daily (Finance, morning and after each event)

| Step | Action                                                                                                          | Screen or call                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1   | Captured but unconfirmed: money taken, booking not confirmed, older than 10 minutes. **Must return zero rows.** | Query 1 in `scripts/ops/pilot-monitor-queries.sql` (read-only, through approved access). Also audit rows `PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING`, `PAYMENT_DUPLICATE_CAPTURE`  |
| F2   | Run detection, then work every OPEN item to RESOLVED or IGNORED with a reason                                   | Admin Finance reconciliation > "Run detection" (`POST /api/admin/payments/finance/detect`, `FINANCE_RESOLVE`); list `GET .../discrepancies`; ageing `GET .../aging`            |
| F3   | Refunds waiting and failed                                                                                      | Admin Refunds > "Waiting for a decision"; `GET /api/admin/grouped/refunds?groupBy=country&status=FAILED`                                                                       |
| F4   | Open chargebacks and the evidence deadline                                                                      | `GET /api/admin/disputes` (`FINANCE_READ`). **Empty on QA 2026-10-12.** Evidence goes in the Razorpay dashboard                                                                |
| F5   | Today's money by currency, from the admin grouped totals (section 9)                                            | `GET /api/admin/grouped/bookings` and `.../payments` and `.../refunds` with `from` and `to`                                                                                    |
| F6   | Match Razorpay dashboard payments for the day with Admin Payments (count and INR total)                         | Razorpay dashboard + Admin Payments. **RAZORPAY-READINESS REC-3: no proof yet that the platform detection compares with Razorpay itself, so this manual match is the control** |

### 6.2 Weekly (Monday)

OP W1 to W8. Add: list Razorpay settlements for the week and match to Admin settlements (T+2 settlement
timing, `RAZORPAY-READINESS.md` S9 [doc]); confirm every PAID payout has a UTR that appears on the bank
statement (Finance A); the owner signs the audit review.

### 6.3 Payout run (per organizer, after the hold)

1. The event is `COMPLETED` or `ARCHIVED` and no session ended in the last hold period (default 7 days,
   `config/configuration.ts:157`) [code].
2. The organizer owner or manager raises it at `/organizer/payouts` > "Generate settlement" (one payout per
   currency). Automatic runs stay off.
3. **FIN-1: read the payout row, not the totals.** After refunds, the organizer's "held" and "pending" totals on
   `/payouts/summary` and `/payouts/finance` still show the refunded amount, while the payout row (gross, refunds,
   net) and the admin settlement row are correct (`CERTIFICATION-EVIDENCE.md` finding 2). The fix is awaiting
   owner approval and is in frozen Finance code, so it is not changed here. Pilot rule: Finance B and the organizer
   both read **gross, refunds and net on the payout row**, and Finance B matches that net to the admin settlement
   row before transferring. Tell each organizer this at the walkthrough, because their own Finance page
   overstates what they are owed after any refund.
4. Finance B reveals the account number ("Show number", with a reason that holds no digits), pays by bank
   transfer, then "Mark paid" with the UTR (OP section 8). Refused if the account is not verified in its current
   version (409 hold). Never use Settlements > "Release" (OP section 8 step 7; provider transfers stay off).
5. Finance A confirms the UTR on the statement. The organizer's "Paid to you" rises by the net amount.

### 6.4 Rule P1

The person who pressed "Mark checked" on an organizer's account does not press "Mark paid" for that organizer's
first payout (OP section 7, gap G1: one capability, `PAYOUT_MANAGE`, covers both; a super admin passes every
check). The owner decides whether to accept this as a written rule or approve splitting the capability
(`PILOT-READINESS.md` decision 16).

---

## 7. Incident response and payment shutdown

Severity, roles, comms templates and rollback are `INCIDENT-RESPONSE.md` and OP section 9. This section replaces
only the "how do I stop payments" part, which the older pages state wrongly (section 13).

### 7.1 The exact switches today

| Switch                                   | How                                                                                                                         | Who may                                                            | Blast radius                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payment stop for India (preferred)**   | `POST /api/admin/payments/outage/country/IN/suspend` with body `{"suspended":true}`; reverse with `false`                   | `PAYMENT_ADMIN` (not granted to pilot staff; owner or super admin) | New payments for India fail closed ("No payment route configured"); nothing else changes. Webhooks, refunds, check-in, ticket wallet, sign-in and free events keep working |
| Payment stop for one provider or route   | `POST /api/admin/payments/outage/provider/razorpay/suspend` or `.../route/:id/suspend`, same body                           | `PAYMENT_ADMIN`                                                    | Same, narrower                                                                                                                                                             |
| Read the posture                         | `GET /api/admin/payments/outage/status`                                                                                     | `PAYMENT_ADMIN`                                                    | None                                                                                                                                                                       |
| **Whole-site maintenance (last resort)** | Admin console Operations > "Maintenance mode", or `POST /api/admin/ops/maintenance` with `{"enabled":true,"message":"..."}` | `PLATFORM_CONFIG`                                                  | Every API request except `/health`, `/ready`, `/metrics`, `/auth/*` and `/admin/*` answers 503. See 7.2                                                                    |

Evidence: `payments/outage/payment-outage.controller.ts:30-60`; `payment-config.service.ts:181-196`
(`resolveTarget` reads only ACTIVE routes and throws a fail-closed error when none matches);
`payment-orchestrator.service.ts:149` (a refund goes to the provider that took the payment, not through route
selection); `ops/ops.controller.ts:85`; `ops/maintenance.guard.ts:57-66` [code]. **I did not run either switch**
(no writes on QA were in scope), so the claim that a suspended route leaves refunds and webhooks working is
read from code, not observed. **OWNER/engineering: rehearse the India suspend and resume once on QA before the
first event.**

What a payment stop does NOT do: buyers can still reserve tickets and hold stock for 10 minutes
(`BOOKING_HOLD_MINUTES`, default 10, `config/configuration.ts:141`), then fail at the pay step. Holds expire by
themselves. A stop with a clear banner is better than a silent one; maintenance mode is the only existing banner.

There is no admin screen for the payment stop (OP gap G19). The on-call engineer runs the call, or the owner does
with a super-admin token. The Operations page has only the maintenance toggle (`apps/admin-web/app/admin/ops/page.tsx:107-173`).

### 7.2 Why maintenance mode is a last resort

The maintenance guard exempts only health, readiness, metrics, `/auth/*` and `/admin/*`. Everything else answers 503,
including:

- **check-in scans** (`POST /api/checkins`), so a live gate stops;
- **ticket loading** for buyers, My bookings and the guest link;
- **the Razorpay webhook** (`payments/webhooks/...`) and the **SES/SNS webhook**: a payment captured during
  maintenance is not confirmed until the provider retries and maintenance is off. Confirm after switching off
  that every payment captured in the window now has a confirmed booking (F1 query).

Never switch maintenance on during a live event unless the gate has a paper fallback. `INCIDENT-RESPONSE.md`
section 3 says maintenance mode "won't lock out operators"; true for admins, but it locks out the gate and
buyers' tickets.

### 7.3 Stop-sales triggers (owner ratifies; OP gap G20)

Stop pilot sales (payment stop for India) when any of these happens: a paid purchase is not confirmed within
15 minutes; a webhook signature failure (`PAYMENT_WEBHOOK_INVALID`); a refund recorded but not sent; a payout that
disagrees with its settlement; a backup older than 26 hours (`PILOT-READINESS.md` section 5). Roll back a release
if, within 30 minutes of it, two buyers in a row hit checkout or ticket-delivery errors (OP section 9).

### 7.4 Pilot-specific incidents

| Incident                          | First action                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Buyer charged, no ticket          | Payment stop for India, run F1, do not retry or refund until Finance has looked at the Razorpay payment (OP section 9) |
| Gate scans failing for everyone   | Check the phone signal and the IP allowance (5.3) before blaming tickets; page on-call; use the printed list           |
| Organizer cancels late            | Section 4.3                                                                                                            |
| Bounced buyer emails              | Section 3.3                                                                                                            |
| Wrong money moved / data exposure | SEV1, owner and security contact at once; preserve the audit log (OP section 9)                                        |

---

## 8. Legal and compliance sign-off list

Nothing here is legal advice. Each row is a decision a named person records before the first sale. **OWNER** names
the signer. The status column is what the repository shows today.

| #   | Item                                                                                               | Signer (OWNER names)                  | Status in the repository                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| L1  | Organizer agreement text (section 1.3), including payouts, refunds, chargebacks, liability         | Counsel + owner                       | Draft with blanks (`docs/commercial/ORGANIZER-AGREEMENT.md`); LEGAL REVIEW                                                  |
| L2  | Terms and conditions and refund policy shown to buyers                                             | Counsel + owner                       | Public pages are drafts (`docs/INDIA_LAUNCH_READINESS.md`: "All four declare themselves drafts"); LEGAL REVIEW              |
| L3  | Privacy policy and DPDP position (roles, purposes, retention, breach notice, grievance contact)    | Counsel + owner                       | Draft (`docs/commercial/PRIVACY-POLICY.md`); LEGAL REVIEW                                                                   |
| L4  | Business details published: legal name, registered office, support email, hours                    | Owner                                 | `supportEmail` set; organizer email, support phone and hours null (`business-details.ts:59-66`)                             |
| L5  | GST: registration state, rate table, who remits admission GST, inclusive vs added on platform fees | Accountant + owner                    | Rules inactive; open questions Q1, Q3, Q10 (`docs/INDIA_LAUNCH_READINESS.md`); LEGAL REVIEW. Activation raises buyer totals |
| L6  | Tax invoice and credit note format for India                                                       | Accountant                            | Receipts and credit notes exist; format not reviewed here; LEGAL REVIEW                                                     |
| L7  | Razorpay live account: KYC complete, settlement account, capture mode, methods                     | Owner                                 | `RAZORPAY-READINESS.md` S1 to S3 (OWNER)                                                                                    |
| L8  | Payment-aggregator or escrow treatment of holding organizer money and paying later                 | Counsel                               | Not addressed anywhere in the repository; LEGAL REVIEW                                                                      |
| L9  | Organizer permits per event (venue, police, fire, music licence, local duty)                       | Organizer; program owner files copies | Not checked by the platform; LEGAL REVIEW on which apply per city                                                           |
| L10 | Age-restricted events: rule for the door and for listings                                          | Counsel + owner                       | Age limit is a text field; not enforced by the product                                                                      |
| L11 | Consumer grievance contact and response time on the storefront                                     | Counsel + owner                       | Organization record has grievance-officer fields; no platform-level grievance page found; LEGAL REVIEW                      |
| L12 | Email sending: sender identity, no marketing, consent position                                     | Owner                                 | Transactional only; no marketing type exists (`message-class.ts`). See `REAL-EMAIL-CERTIFICATION.md`                        |
| L13 | Financial controls: two finance people, P1 rule, FIN-1 mitigation, G19 and G20                     | Owner                                 | `PILOT-READINESS.md` decisions 15 to 17                                                                                     |
| L14 | Data handling: who may export attendee lists, retention of exports                                 | Owner                                 | Owners and managers can export; check-in staff cannot (OP section 4)                                                        |
| L15 | Go / no-go record for the pilot                                                                    | Owner                                 | `PILOT-READINESS.md` GO criteria; record who decided and when                                                               |

---

## 9. Daily pilot report

One page, completed by the program owner or the person the owner names by 10:00 India time for the previous
day, and an extra page after each event. File them in the pilot folder. **Day windows:** the admin `from` and `to`
filters are calendar days in UTC and filter by `createdAt` (`admin-grouping.service.ts:304-339`;
`reports.controller.ts` date fields). An India day starts 5.5 hours before a UTC day, so a late-evening sale
lands in the next UTC day. Say so in the report header, or use the SQL route with explicit `+05:30` bounds.

Every number comes from the source shown. If a source cannot be reached, write BLOCKED, not zero.

```
Date (India):            Report by:            Environment / commit:
Events live today:       Events with doors today:      On-call engineer:
```

| #   | Metric                                                                       | Source (exact)                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Bookings created, by status (CONFIRMED, EXPIRED, PENDING_PAYMENT, CANCELLED) | `GET /api/admin/grouped/bookings?groupBy=country&status=<STATUS>&from=<day>&to=<day>` (count and per-currency total). Verified shape on QA 2026-10-12: `{groups:[{key,count,totals:[{currency,totalMinor}]}]}`                                                               |
| M2  | Money confirmed today, INR                                                   | M1 with `status=CONFIRMED`; never add currencies together                                                                                                                                                                                                                    |
| M3  | Payments by status (SUCCEEDED, FAILED)                                       | `GET /api/admin/grouped/payments?groupBy=country&status=<STATUS>&from&to`                                                                                                                                                                                                    |
| M4  | Payment success rate                                                         | M3 SUCCEEDED / (SUCCEEDED + FAILED). Counters in `/api/metrics` (`etg_payments_*_total`) reset on every deploy; use only for a within-day check                                                                                                                              |
| M5  | Refunds requested / completed / failed                                       | `GET /api/admin/grouped/refunds?groupBy=country&status=REQUESTED\|COMPLETED\|FAILED&from&to`                                                                                                                                                                                 |
| M6  | Oldest refund waiting for a decision (age)                                   | Admin Refunds > "Waiting for a decision", oldest row. Target: under 1 business day                                                                                                                                                                                           |
| M7  | Captured but unconfirmed (must be 0)                                         | Query 1, `scripts/ops/pilot-monitor-queries.sql`; audit `PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING`, `PAYMENT_DUPLICATE_CAPTURE` (`GET /api/admin/audit?action=...&from&to`)                                                                                                     |
| M8  | Webhook failures                                                             | Audit/logs for `PAYMENT_WEBHOOK_INVALID`; no alert exists (OP G21), so an engineer checks logs or `payment_webhooks{result="signature_invalid"}` in `/api/metrics`                                                                                                           |
| M9  | Check-ins today, per event                                                   | `GET /api/admin/audit/summary?action=TICKET_CHECKED_IN&eventId=<id>&from&to`; organizer view `GET /api/reports/events/<id>`; compare with tickets sold                                                                                                                       |
| M10 | Duplicate, wrong-session and not-valid scans                                 | Gate screen "Recent scans"; supervisor notes (check-in rows are the system of record)                                                                                                                                                                                        |
| M11 | Reconciliation: open discrepancies and the oldest age                        | `GET /api/admin/payments/finance/discrepancies`, `.../aging`                                                                                                                                                                                                                 |
| M12 | Open chargebacks                                                             | `GET /api/admin/disputes`                                                                                                                                                                                                                                                    |
| M13 | Payouts pending, bank accounts waiting verification                          | Admin Payouts; monitor queries 2 and 3                                                                                                                                                                                                                                       |
| M14 | Email health: failed or bounced booking emails                               | `GET /api/admin/notifications/health?hours=24` (provider outcomes) and `GET /api/admin/notifications?channel=email&status=FAILED` and the `deliveryState` of each row (`BOUNCED`, `UNDELIVERED`, `COMPLAINED`). Suppression list `GET /api/admin/notifications/suppressions` |
| M15 | Queue and platform health                                                    | `GET /api/admin/ops/health` (`database`, `redis`, `queue.recentFailed`, `backup.status`/`ageHours`, `appEnv`) or `node scripts/ops/pilot-health-check.mjs` (exit 0 healthy)                                                                                                  |
| M16 | Backup age (limit 26 hours)                                                  | M15 `backup.ageHours`; `backup.status` of `never` is a failure. On QA 2026-10-12 it reads `never`                                                                                                                                                                            |
| M17 | Support items: opened, closed, oldest open (age)                             | `GET /api/admin/support`; the status is OPEN, TRIAGED or CLOSED. Nothing times them, so the reporter reads the oldest                                                                                                                                                        |
| M18 | Feedback: ratings and comments received                                      | `GET /api/admin/support` filtered to kinds CSAT, ORGANIZER_CSAT, GENERAL, BUG, FEATURE                                                                                                                                                                                       |
| M19 | Incidents: number, severity, owner, state                                    | The pilot log (manual)                                                                                                                                                                                                                                                       |
| M20 | Decisions needed from the owner                                              | Free text                                                                                                                                                                                                                                                                    |

Signature line: reporter, date, time. Weekly scorecard (OP W8): events run, tickets sold, refunds, incidents,
organizer complaints, CSAT.

---

## 10. Organizer and customer feedback

| Channel                         | What exists in the product [code]                                                                                                                      | What is manual                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer feedback widget        | Floating button on the storefront; a message with a star rating is a `CSAT`, without is `GENERAL` (`apps/customer-web/components/feedback-widget.tsx`) | Reading and triage at `/admin/support`                                                                                                         |
| Customer help forms             | `/help/contact`, `/help/bug`, `/help/feature` post `CONTACT`, `BUG`, `FEATURE`                                                                         | Same                                                                                                                                           |
| Event reviews                   | The `reviews` capability is true on QA (`GET /api/capabilities`, 2026-10-12)                                                                           | Not part of the pilot scorecard; read them by hand if present                                                                                  |
| Organizer feedback              | "Send feedback" box (`apps/organizer-web/components/organizer-feedback.tsx`), kind `ORGANIZER_CSAT`                                                    | A call after each event                                                                                                                        |
| Post-event buyer survey         | **None.** No automatic message goes to buyers after an event, and event reminders reach nobody in an email-only pilot (INDIA-COMMUNICATIONS section 2) | A short form emailed by the organizer or program owner with the event contact's help. Log the summary as a support item so there is one source |
| Organizer interviews            | None                                                                                                                                                   | 20-minute call with each organizer within 2 days of each event; one structured retro at the end of the pilot                                   |
| Complaints against an organizer | Shown on the organizer's detail page ("open complaints") and `GET /api/admin/support/complaints/:organizationId`                                       | Follow-up                                                                                                                                      |
| Gate feedback                   | None                                                                                                                                                   | Supervisor's notes (section 5.4)                                                                                                               |

Suggested organizer questions after each event: was the money right, was the gate smooth, what did buyers ask you
that we should have answered, what would stop you running the next event with us. Suggested buyer questions: could
you find your ticket, did the email arrive, how long did the gate take, would you buy again.

---

## 11. Pilot calendar (suggested)

| Week | Focus                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -1   | Owner actions in `PILOT-READINESS.md` section 2; real-email certification (`REAL-EMAIL-CERTIFICATION.md`); staff named; rehearsals (7.1 payment stop, 5.2 invited scanner) |
| 0    | Onboard organizers 1 and 2 (sections 1 and 2); walkthroughs; free test events                                                                                              |
| 1    | First two real events, smallest first; same-day review of the daily report                                                                                                 |
| 2    | Organizers 3 to 5; first payouts after the hold; first weekly review                                                                                                       |
| 3-4  | Remaining events; measure scan rate and replace the section 5 assumptions                                                                                                  |
| 5    | Retro; GA / extend / stop decision recorded (`PILOT-GUIDE.md` exit criteria)                                                                                               |

---

## 12. What this playbook does not cover

- Regulated cinema ticketing, Telangana and Vijayawada pricing: OFF for the pilot.
- Reserved-seating events and non-INR currencies.
- Provider (Razorpay Route) transfers: OFF by the owner's release gate.
- SMS, WhatsApp and push: not available; DLT is an external approval (`INDIA-COMMUNICATIONS.md`).
- Changing any setting, permission or credential. Every OWNER item is for the owner.

---

## 13. Claims in existing pilot documents that are wrong or out of date

Checked against `3ef1b51d`. Fix when each page is next touched (this PR changes none of them, to keep it to the new
documents).

| #   | Document and place                                                                                                                                                                         | The claim                                                                                    | What the code shows                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | `PILOT-READINESS.md` section 1, "Instant payment stop: GAP, only the whole-site maintenance flag exists (G19)"; `OPERATING-PROCEDURES.md` gap G19 ("payment maintenance is the same flag") | There is no payment-only stop                                                                | `POST /api/admin/payments/outage/{country,provider,route}/.../suspend` suspends payments only (`payment-outage.controller.ts:30-60`); resolution reads active routes only (`payment-config.service.ts:181-196`). It has no screen, but it exists. OP section 9 says "finer controls are API-only", so OP contradicts its own gap row |
| W2  | `INCIDENT-RESPONSE.md` section 3 and "Payment provider outage" runbook                                                                                                                     | Maintenance mode "won't lock out operators" and is suggested for a high payment failure rate | True for admins. It also blocks check-in, buyers' tickets and the payment and email webhooks (`maintenance.guard.ts:57-66`). The runbook never mentions the payment-only stop                                                                                                                                                        |
| W3  | `INCIDENT-RESPONSE.md` "Database issue": "Restore via PITR to just before the incident"                                                                                                    | Point-in-time recovery                                                                       | Railway provides none; OP section 11 already says `DISASTER-RECOVERY.md` assumes it. Restore a verified dump (`INFRASTRUCTURE.md` section 2)                                                                                                                                                                                         |
| W4  | `INCIDENT-RESPONSE.md` section 4: "Migrations are additive"                                                                                                                                | Rolling code back never needs a down migration                                               | `PILOT-READINESS.md` section 5 says two October migrations are one-way; old images can fail on the new schema                                                                                                                                                                                                                        |
| W5  | `PILOT-GUIDE.md` section 2: "1-3 pilot organizers"                                                                                                                                         | Pilot size                                                                                   | The brief and every Round K document say 3 to 5                                                                                                                                                                                                                                                                                      |
| W6  | `PILOT-GUIDE.md` section 3: SMS/WhatsApp/Push "the platform does not collect phone numbers"; `SUPPORT-PLAYBOOK.md` "phone/push recipient plumbing is pending"                              | Numbers are not collected                                                                    | Phone sign-in and sign-up collect and verify numbers (`phone-otp.service.ts`); QA `GET /api/capabilities` has `phoneSignIn: true`. `INDIA-COMMUNICATIONS.md` E8 already flagged this and it is unfixed                                                                                                                               |
| W7  | `PILOT-GUIDE.md` section 3 ("Tax is not modelled"); `ORGANIZER-GUIDE.md` section 8 ("tax is not modelled in the pilot")                                                                    | No tax                                                                                       | A tax engine exists (`apps/api/src/tax`, `admin/tax-rules.service.ts`, `GET /api/admin/tax-rules`); rules ship inactive, so reports are pre-tax only while GST is off                                                                                                                                                                |
| W8  | `PILOT-GUIDE.md` section 3, `SUPPORT-PLAYBOOK.md` section 2, `ORGANIZER-GUIDE.md` section 10                                                                                               | A fixed 48-hour refund window                                                                | Per event: `refundsEnabled` and `refundCutoffHours`, default on and 48 (`schema.prisma:1369-1371`; `refunds.service.ts:332`)                                                                                                                                                                                                         |
| W9  | `PILOT-GUIDE.md` section 3 ("check-in is online-only, no offline queue") and `CHECKIN-GUIDE.md` sections 1 and 4                                                                           | No offline check-in at all                                                                   | Offline check-in exists behind `OFFLINE_CHECKIN_ENABLED` (off by default); OP section 4 and gap G4 are correct                                                                                                                                                                                                                       |
| W10 | `ORGANIZER-GUIDE.md` section 6: "Invite a member by email"                                                                                                                                 | The platform emails the invitation                                                           | `inviteMember` returns a link to copy; no notification is created (`organizations.service.ts:540-609`)                                                                                                                                                                                                                               |
| W11 | `PILOT-READINESS.md` section 4: "Cancelling an event: cancel each show"                                                                                                                    | Organizers can do this                                                                       | The only organizer cancel screen is on the cinema schedule; a GA organizer has none (section 4.3 here; OP gap G3)                                                                                                                                                                                                                    |
| W12 | `PILOT-GUIDE.md` section 6 step 1: "sign a lightweight pilot agreement (out of band)"                                                                                                      | Adequate as stated                                                                           | The only agreement is a draft with blanks, and the product records no acceptance (section 1.4). This is a gap, not an error of fact                                                                                                                                                                                                  |
| W13 | `SUPPORT-PLAYBOOK.md` section 2: "Refund not eligible ... **>48h before** the session"                                                                                                     | Always 48 hours                                                                              | See W8                                                                                                                                                                                                                                                                                                                               |
| W14 | `SES-NEW-ACCOUNT-CUTOVER.md` Step 6 and `docs/notifications/PROVIDER-SETUP.md` step 8: "Confirm the subscription in the console"                                                           | The console can confirm a production subscription                                            | The confirmation token is never captured or logged in production (`sns-confirmation.guard.ts:25-31`), so the console step cannot be completed there. The cutover guide flags the gap; `PROVIDER-SETUP.md` does not. See `REAL-EMAIL-CERTIFICATION.md`                                                                                |
| W15 | `INDIA-COMMUNICATIONS.md` section 2 table: `BOOKING_CANCELLED` (customer's own) is delivered as email and in-app                                                                           | A cancelling buyer is emailed                                                                | No code path creates a `BOOKING_CANCELLED` notification (`refunds.service.ts:379-383` says the free-cancel path "has never sent" it); the template and policy exist only. `SHOW_CANCELLED` and `REFUND_COMPLETED` are sent (`show-cancellation-fanout.service.ts:155`, `refunds.service.ts:1137`)                                    |
