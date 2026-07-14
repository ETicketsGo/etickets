# ETicketsGo — Customer Guide (Pilot)

How buying and using a ticket works for end customers. Written so support can walk
a customer through it and so it can double as a public help article. All routes
below are on **customer-web**.

---

## 1. Discover events & movies

- **Home** — `/`.
- **Browse events** — `/events`; an event page is `/events/[slug]`.
- **Browse movies** — `/movies`; a movie page is `/movies/[slug]`.
- **Explore / curated discovery** — `/explore`.
- **Organizers** — `/organizers`, and a public organizer profile at
  `/organizers/[id]`.
- Use search and filters to narrow down. You can browse without an account, but
  you'll need to log in (`/login`) or register (`/register`) to book.

## 2. Book an event (general admission / seated event)

1. Open the event (`/events/[slug]`) and pick a **session** (date/time).
2. Choose your **ticket types and quantities**.
3. Proceed to checkout — this creates a booking and **holds** your tickets for
   **10 minutes**. Finish payment within that window or the hold is released.
4. Continue to the **payment** step: `/booking/[id]/payment`.

![screenshot: event ticket selection]

## 3. Book a movie (pick a show → select seats)

1. Open the movie (`/movies/[slug]`) and pick a **show** — this opens
   `/shows/[sessionId]`.
2. On the **seat map**, select your seat(s). Selected seats are held for you (the
   same 10-minute hold) so no one else can take them while you pay.
3. Continue to `/booking/[id]/payment`.

![screenshot: /shows/[sessionId] seat selection]

## 4. Pay

1. On `/booking/[id]/payment`, review your order and pay.
2. Fees follow the organizer's fee mode (typically **added on top** for the
   buyer).
3. **Pilot note:** payments run through the configured provider. In sandbox/dev
   the platform uses a **mock** provider; once real keys are set, real charges
   apply. If a payment fails, the booking is not confirmed and the hold expires —
   simply rebook.
4. On success you're taken to the **confirmation** page:
   `/booking/[id]/confirmation`.

## 5. Get and show your QR ticket

- Your tickets live in your account:
  - **All tickets** — `/account/tickets`
  - **A single ticket (with QR)** — `/account/tickets/[ticketId]`
  - **Your bookings/orders** — `/account/bookings`
- At the gate, open the ticket detail and show the **QR code** for the staff to
  scan. Each ticket has its own QR — for a multi-ticket booking, each guest shows
  their own.

![screenshot: /account/tickets/[ticketId] QR]

## 6. Add to calendar / share

- From the confirmation page or ticket detail you can **add the event to your
  calendar** and **share** it (share link / copy).

## 7. Request a refund

1. Refunds are subject to a **48-hour window**: you can request a refund only
   **more than 48 hours before** the session start, and only for a booking that
   is still `CONFIRMED` (or partially refunded).
2. Request it from your booking. If you're inside the window (within 48h of the
   session) or the tickets are already refunded/used, you'll see a **"not
   eligible"** message — that's expected.
3. An organizer owner or platform admin approves it. Once approved, your money is
   refunded to the original payment method and you receive a **confirmation
   email**.

## 8. Reviews, wishlist & following

- **Save / wishlist** events — `/account/saved`.
- **Follow organizers** — `/account/following`; see their new events.
- **Reviews** — leave a review on events you've attended (from the event page).
- **Profile** — `/account/profile`.

> These are live pilot features (`savedEvents`, `reviews`, `organizerProfiles`,
> `community` flags are on).

## 9. Get help

- **Help center** — `/help`.
- **Contact us** — `/help/contact`.
- **Report a bug** — `/help/bug`.
- **Request a feature** — `/help/feature`.
- **Feedback button** — a floating "Feedback" button is available across the site;
  leave a message and an optional 1–5 star rating.

All of the above reach the platform support inbox; response targets are in the
[SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

## 10. Notifications you'll receive

- **Email** — booking confirmation, refund completion, and check-in confirmation
  are sent by email (once the platform's email transport is configured).
- **SMS / WhatsApp / push** are **not** active in the pilot — the platform does
  not collect phone numbers or push tokens yet. Rely on email and your in-app
  account.
