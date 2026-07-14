# ETicketsGo — Organizer Guide (Pilot)

Everything a pilot organizer needs, in order, from sign-up to payout. All routes
below are in **organizer-web** unless noted. The API runs under `/api`.

> Roles you'll use: **ORGANIZER_OWNER** (full control incl. finances and refund
> approval), **ORGANIZER_MANAGER** (operations, no ownership actions),
> **CHECKIN_STAFF** (gate scanning only).

> `![screenshot: …]` marks where a UI capture belongs.

---

## 1. Sign up & set up your organization

1. Go to organizer-web and **register** (or accept your invite).
2. On first sign-in you land on the **dashboard** at `/organizer`. Because an
   organization is required before anything else, you'll create/confirm it here.
3. Open the **onboarding checklist** at `/organizer/onboarding`. It tracks four
   steps, derived from your real data:
   - **Create your organization** (done once your org exists) → `/organizer/settings`
   - **Add your first venue** → see §2
   - **Invite a team member** → see §6
   - **Create & publish an experience** → see §3 or §4

![screenshot: /organizer/onboarding checklist]

> During the pilot your organization may need admin verification before you can
> publish. If publishing is blocked, ping your program contact — an admin reviews
> organizers in `/admin/organizers`.

## 2. Create a venue

1. Venues are managed from your organization settings / onboarding flow.
2. Add the venue name, address, and capacity details.
3. A venue is reusable across many events.

> Cinemas (screens + seat maps) are a **separate** flow used for movies — see §4.

## 3. Create an Event (general admission / seated event)

Use the **new-event wizard** at `/organizer/events/new`. It has six steps:

1. **Basic details** — title, description, category, experience type.
2. **Venue** — pick the venue you created in §2.
3. **Sessions** — one or more dated sessions (start/end). Each session is a
   distinct occurrence customers book against.
4. **Ticket types** — name, price, and quantity per ticket type (e.g. General,
   VIP). Prices are entered per ticket type.
5. **Fee handling** — choose the fee mode (default **CUSTOMER_PAYS**, i.e. fees
   added on top for the buyer).
6. **Review** — confirm and create. The event starts in **DRAFT**.

![screenshot: /organizer/events/new wizard — Sessions step]

Manage an existing event at `/organizer/events/[id]`, with tabs:

- `/sessions` — add or edit sessions
- `/tickets` — ticket types
- `/attendees` — attendee list
- `/orders` — orders for this event
- `/reports` — event performance
- `/checkin` — gate scanning (see [CHECKIN-GUIDE](./CHECKIN-GUIDE.md))
- `/edit` — edit event details

## 4. Set up Movies (cinema experiences)

Movies use a catalog → cinema → screen → seat-map → shows chain:

1. **Movie catalog** — `/organizer/movies` (add via `/organizer/movies/new`,
   edit at `/organizer/movies/[id]`). Create the film's metadata.
2. **Cinema** — `/organizer/cinemas` (add via `/organizer/cinemas/new`). A cinema
   is the physical venue.
3. **Screen** — inside a cinema at `/organizer/cinemas/[id]/screens`, add screens
   (auditoriums).
4. **Seat-map generator** —
   `/organizer/cinemas/[id]/screens/[screenId]/seatmap`. Generate the seat grid
   (rows/columns, categories). This is what customers pick seats from.
5. **Schedule shows** — create show sessions that pair a movie with a screen at a
   date/time. These appear to customers as bookable shows
   (`/shows/[sessionId]` on customer-web).

![screenshot: seat-map generator]

## 5. Publish & admin review

1. From the event, **submit for review**: this calls
   `POST /api/events/:id/submit` and moves the event `DRAFT → UNDER_REVIEW`.
2. A platform **admin approves or rejects** it (`/admin/events`,
   `POST /api/admin/events/:id/review`). Approval moves it to **PUBLISHED**;
   rejection returns it with a reason.
3. Once **PUBLISHED**, the event is discoverable on customer-web (`/events`,
   `/events/[slug]`, and — for movies — `/movies`, `/shows/[sessionId]`).
4. You can **pause** a live event (`POST /api/events/:id/pause`) and **resume** it
   (`/resume`). Other statuses you may see: `SOLD_OUT`, `CANCELLED`, `COMPLETED`,
   `ARCHIVED`.

## 6. Invite your team

Manage staff at `/organizer/team`.

1. Invite a member by email and assign a role:
   - **ORGANIZER_MANAGER** — day-to-day operations: manage events, attendees, and
     orders. Financial reads (revenue/payouts) and refund approval are
     **owner-scoped** — see the note below.
   - **CHECKIN_STAFF** — can only run the gate check-in screen for your org's
     tickets.
2. Only an **ORGANIZER_OWNER** can approve refunds and mark ownership-level
   actions.

> Support tip: if a staff member "can't see revenue", their role is likely
> CHECKIN_STAFF or MANAGER — financial reads require OWNER. See the
> [SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

## 7. View attendees & orders

- **Attendees** — `/organizer/events/[id]/attendees`
  (`GET /api/events/:id/attendees`), filterable by session and status.
- **Orders** — `/organizer/events/[id]/orders`
  (`GET /api/events/:id/orders`).

## 8. Run reports

- Per-event performance — `/organizer/events/[id]/reports`
  (`GET /api/reports/events/:eventId`).
- Figures are **pre-tax** — tax is not modelled in the pilot.

## 9. Request payouts

Payouts settle your net proceeds (sales minus completed refunds).

1. Go to `/organizer/payouts`.
2. **Generate** a payout (`POST /api/payouts/generate`) — this collects the
   settle-able balance into a payout in **PENDING** status. You cannot generate a
   duplicate while one is PENDING/SCHEDULED.
3. A platform **admin marks it paid** once the money is sent out-of-band
   (`POST /api/admin/payouts/:id/pay` → status **PAID**). Marking paid is a
   bookkeeping action; the pilot does not wire a bank rail.

![screenshot: /organizer/payouts]

## 10. Manage refunds

1. Customers request refunds themselves (subject to the **48-hour** pre-session
   window). See [CUSTOMER-GUIDE](./CUSTOMER-GUIDE.md).
2. As **ORGANIZER_OWNER** you (or a platform admin) approve/reject requests
   (`POST /api/refunds/:id/process` with `APPROVE`/`REJECT`).
3. On approval, the refund settles atomically: tickets go `REFUNDED`, seats/stock
   return, the provider refund is issued exactly once, and the customer is
   emailed.

## 11. Where to get help

- In-app organizer help — `/organizer/help`.
- Enterprise "coming soon" modules — `/organizer/premium` (flag-gated; off in the
  pilot).
- Escalate issues to your program contact; support triages via
  [SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).
