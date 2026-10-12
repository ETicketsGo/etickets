# Customer journey review (India GA event and free event)

Reviewed 2026-10-12 on QA (`https://qa.eticketsgo.com`, API `api-qa-f580`), deployed from `main 3ef1b51`.
Reviewer: K-2. Browser: Playwright Chromium, 390 px (mobile, touch) first, then 1440 px, with the browser
time zone set to `America/New_York` so a venue-clock error cannot hide.

Test data: organizer "Bengaluru Live", venue "Phoenix Arena" (Bengaluru, `Asia/Kolkata`), events named
`K-TEST ...`. One TEST Razorpay payment (Netbanking, test bank, Razorpay mock bank page, contact 8121234567).
No real instrument was used. Nothing on production or UAT was touched.

## What was walked

| Path     | Actor                                 | Steps                                                                                                                                                 |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid GA  | guest and `customer1@eticketsgo.test` | discover, event, pick tickets, checkout, Razorpay, confirmation, ticket (print view), check-in by API (`owner@`)                                      |
| Free     | guest                                 | event, pick tickets, "Get my tickets", confirmation                                                                                                   |
| Recovery | guest and customer                    | sold out, closed and not-yet-open ticket tier, invalid promo code, payment failed (bank "failure"), network error on pay, hold timer, cancel, revisit |

Organizer entered (API): title "K-TEST Neon Nights Live", 24 Oct 2026 19:30 IST to 22:30, age 18+, three terms,
two artists, refund policy text, refunds on with 48 h cut-off, tiers General Rs 1,000.00 (100) and Early bird
Rs 750.50 (2).

## Matrix (PASS / FAIL / BLOCKED)

Criteria: **V** visual consistency, **I** images and fallbacks, **A** information accuracy, **P** price and fee
disclosure, **Z** currency and time zone, **E** error states and recovery, **X** accessibility (axe plus
keyboard), **M** mobile usability, **T** trust and confidence.

| Step                            | V       | I    | A       | P                             | Z                    | E                                          | X                           | M              | T                                 |
| ------------------------------- | ------- | ---- | ------- | ----------------------------- | -------------------- | ------------------------------------------ | --------------------------- | -------------- | --------------------------------- |
| 1 Discover (/discover, /events) | PASS    | PASS | PASS    | PASS                          | PASS                 | n/a                                        | PASS                        | PASS           | PASS                              |
| 2 Event details                 | PASS    | PASS | PASS    | PASS                          | PASS (note Z1)       | n/a                                        | PASS                        | PASS           | PASS                              |
| 3 Ticket selection              | PASS    | n/a  | PASS    | PASS                          | PASS                 | **FAIL** (F1, fixed)                       | PASS                        | PASS (note M1) | PASS                              |
| 4 Checkout (Review and pay)     | PASS    | n/a  | PASS    | **FAIL** (F2, fixed)          | **FAIL** (F3, fixed) | PASS                                       | PASS                        | PASS           | **FAIL** (F4, fixed; F5 proposed) |
| 5 Razorpay (TEST)               | PASS    | n/a  | PASS    | PASS (Rs 1,047.68 = checkout) | n/a                  | PASS (failure and network error recovered) | BLOCKED (third-party frame) | PASS           | PASS                              |
| 6 Confirmation                  | PASS    | n/a  | PASS    | **FAIL** (F2, fixed)          | **FAIL** (F3, fixed) | PASS                                       | PASS                        | PASS           | PASS                              |
| 7 QR ticket (print view)        | PASS    | n/a  | PASS    | n/a                           | PASS (GMT+5:30)      | n/a                                        | PASS                        | PASS           | PASS                              |
| 8 Check-in (API)                | n/a     | n/a  | PASS    | n/a                           | n/a                  | PASS (DUPLICATE, WRONG_SESSION)            | n/a                         | n/a            | n/a                               |
| Free event path                 | PASS    | PASS | PASS    | PASS ("Free", no fees)        | PASS                 | PASS                                       | PASS                        | PASS           | PASS                              |
| Email record                    | BLOCKED |      | BLOCKED |                               |                      |                                            |                             |                | BLOCKED (F6)                      |

Money agreement for the paid test booking `ETG-IND-2026-000037` (one General ticket):

| Place                             | Tickets                        | Fees (processing + convenience)      | GST added on fees       | Total    |
| --------------------------------- | ------------------------------ | ------------------------------------ | ----------------------- | -------- |
| Event page (quote)                | 1,000.00                       | 24.08 + 23.60 (ex-GST 20.40 + 20.00) | 3.68 + 3.60             | 1,047.68 |
| Checkout page (account)           | 1,000.00                       | same                                 | same                    | 1,047.68 |
| Checkout page (guest), before fix | 1,000.00 "includes 159.82 GST" | same                                 | "GST on fees (18%)"     | 1,047.68 |
| Razorpay sheet                    |                                |                                      |                         | 1,047.68 |
| Admin booking record              | 100000                         | 4040 (customerFeeMinor)              | 728 (in taxMinor 15982) | 104768   |
| Receipt INV-2026-000018           | 100000                         | 4040                                 | tax 15982               | 104768   |

All amounts agree. The only disagreement was how the guest screens described the GST (F2).

## Findings

Severity: High (money copy or a dead end a buyer cannot recover from), Medium (wrong or missing information),
Low (polish, proposal only). Every finding was reproduced on QA at `main 3ef1b51` on 2026-10-12.

### F1 Closed or not-yet-open ticket tier is offered as buyable (Medium, FIXED)

- Reproduce: create a ticket type with `salesEndAt` one hour ago (or `salesStartAt` in five days). The event page
  shows "Rs 300 - 10 left" with a working quantity selector. The buyer fills in the form and is refused with
  `409 "Closed tier is not currently on sale."` at the last step. `POST /bookings/quote` even prices it.
- Root cause: the public event payload carried no sales window, so the page could not know.
- Fix: `public-events.service.ts` adds `saleState` (`ON_SALE`, `NOT_YET`, `CLOSED`) and `salesStartAt` per ticket
  type, from the same test the booking path applies; the event page shows "Sales closed" or "Sales open <date>",
  disables the selector and offers no quantity. Keys added in en and fr-CA.
- Tests: `ticket-sale-window.spec.ts` (jest), `customer-journey-honesty.spec.ts` (Playwright).
- Remaining risk: other surfaces that list ticket types (the seat page `/shows/[id]`, mobile app) do not read
  `saleState` yet. The booking path still refuses correctly, so no money risk.

### F2 Guest checkout and confirmation misstate the GST in the ticket price (High for copy, no money impact, FIXED)

- Reproduce: buy one Rs 1,000 ticket as a guest. The event page says "Tickets, includes Rs 152.54 GST". The guest
  payment and confirmation pages say "includes Rs 159.82 GST" and show a single "GST on fees (18%)" line. The
  signed-in checkout shows 152.54 with CGST and SGST lines. 159.82 is the ticket GST (152.54) plus the GST on the
  fees (7.28): the screen folded the fee GST into the ticket price and then showed it again as a fee row.
- Root cause: `guest-booking.service.ts` selected `basis` and `inclusive` for each tax line and then dropped them
  when building the view, so the breakdown treated every line as "included in the tickets".
- Fix: the guest view now passes `basis` and `inclusive` (shared type extended, optional). Display only; no
  pricing, fee, tax, payment or refund calculation changed.
- Tests: `guest-booking.service.spec.ts` asserts the lines keep their basis (fails on the old mapping).
- Remaining risk: a guest booking made before `basis` was stored has no basis and is drawn as before.

### F3 Show time has no zone on guest screens and on the account payment page (Medium, FIXED)

- Reproduce: browser in `America/New_York`, India event. The time shown is correct (venue clock, 7:30 pm) but the
  guest payment, guest confirmation and account payment pages print "24 Oct 2026, 7:30 pm" with no zone. The
  account confirmation, the event Sessions row and the ticket already write "GMT+5:30". A buyer abroad reads the
  bare time as their own.
- Fix: the zone abbreviation is written next to the time on those pages, as the account confirmation does.
- Evidence: `customer-journey/23-payment-AFTER-m.png`.

### F4 Payment screen hides the refund terms and says "Refundable per policy" for a no-refund event (Medium, FIXED)

- Reproduce: event with `refundsEnabled=false` and policy text "All sales final". The payment screen shows the tile
  "Refundable per policy" and no terms. The policy is only on the event page, one step before paying.
- Fix: both payment screens show a "Refund terms" panel (the organizer's rule and own words); the tile says
  "No refunds" when refunds are off. The API now returns `refundPolicy` (account booking) and the refund fields
  (guest booking). Display only.
- Tests: Playwright `customer-journey-honesty.spec.ts`; guest view contract in `guest-booking.service.spec.ts`.

### F5 Checkout does not name the seller or give a support contact (Low, PROPOSED)

- The event page names the organizer ("Bengaluru Live"). The payment page names neither the organizer nor a
  support address or phone; only a "Help centre" link. Proposal: show "Sold by <organizer>" and the support
  email on the payment page. Needs organizer name added to the guest and account booking views. Effort: 0.5 day.
  Owner action: confirm the support address to print (`legalName` and `supportEmail` are still null per the
  Twilio A2P note).

### F6 Email record cannot be checked from outside (Low, BLOCKED)

- The confirmation says "We emailed a link". There is no read access to a mailbox or notification log with the
  test credentials, so "email record = receipt" is BLOCKED, not PASS. The receipt (INV-2026-000018) and admin
  booking record do agree with checkout. Owner action: read the delivery log for booking `ETG-IND-2026-000037`.

### F7 Smaller observations (Low, PROPOSED, not changed)

- M1: several controls are under 44 px tall on mobile (quantity selector 64x35, Share 80x31, footer text links
  16-19 px high, header icon 32x32). Cross-browser CSS and shared layout belong to K-1, so not touched.
- No sticky "Continue to payment" button on the mobile event page; the button is after a long form (state
  list, guest fields). A sticky bar with the total would help. Shared layout, proposed only.
- After a guest cancels, reopening the booking link says "This booking is not open in this browser. Open the link
  we emailed you", which reads as an access error rather than "you cancelled this booking".
- A free booking issues a Rs 0 TAX_INVOICE (INV-2026-000019). Not a defect for the buyer; finance should decide
  whether a zero invoice is wanted.
- A fully sold-out event shows "Sold out" only on the tier row, with an empty guest form and an enabled
  "Continue to payment" below. No event-level "Sold out" notice.
- The guest checkout has no promo-code field; the signed-in checkout does. Invalid code message
  ("That code is not valid for this booking.") is clear.
- Dates: the event hero line shows "7:30 pm" without a zone abbreviation; the Sessions row has it.

## Criteria detail

- **Information accuracy.** Date, time (19:30 IST), duration (3 hours), age limit (18+), venue and city
  (Phoenix Arena, Bengaluru), organizer, artists, terms, refund policy and ticket prices all equal what the
  organizer entered through the API. The venue address is reordered ("Whitefield, KA, Bengaluru, India" for
  "Whitefield, Bengaluru, KA"), which is harmless.
- **Time zone.** With the browser in New York the event page, Sessions row, ticket face and confirmation show
  IST or GMT+5:30; only F3 lacked the label.
- **Images.** The test events have no uploaded image; the branded placeholder tile renders, no broken image on any
  page (checked `img.naturalWidth` on every page).
- **Accessibility.** axe (WCAG 2 A/AA, 2.1 AA) returned zero violations on: event page (390 and 1440), selected
  tickets, guest payment, account payment, confirmation, free event and result, ticket print view, discover and
  events list. Keyboard only (1440): Tab reaches every control in DOM order with a visible focus ring; the
  purchase was completed to the payment page with keys only (select quantity with the arrow key, type name and
  email, Enter on "Continue to payment"). Razorpay's own frame was not audited (third party).
- **Error states.** Sold out: tier shows "Sold out", selector disabled. Sales window: F1. Invalid promo: clear
  message. Payment failed (bank failure): "The payment didn't go through. Try again, or use another payment
  method.", booking and hold stay, Pay still works. Network error on pay: "Payment could not be completed.
  Please try again." Hold: countdown shown (10 minutes); an expired hold was not observed to completion
  in this run (BLOCKED: the countdown was still running when testing ended; hold expiry is covered by existing
  API tests).
- **Check-in.** Ticket QR scanned with the owner token: `SUCCESS`, then `DUPLICATE`, and `WRONG_SESSION` for
  another session. Only the ticket created for this review was admitted.

## Evidence

Screenshots: `C:\etg-wt\k-shots\k-journey\` (`01-event-*`, `02-selected-m`, `03-after-continue-m`,
`04-razorpay-m`, `05*-rzp-*`, `06-confirmation-m`, `07-ticket-m`, `10-free-event-m`, `12-free-result-m`,
`20-soldout-m`, `21-sales-window-m` (before), `22-sales-window-AFTER-m` and `23-payment-AFTER-m` (after, local
stack), `30-payment-failed-m`, `33-network-error-m`, `34-cancelled-revisit-m`, `41/42` account checkout and promo,
`50-*` discovery and axe sweeps).

## Limitations

- Fixes F1 to F4 were verified in a browser against a local stack (API 4112, web 3112) and by unit and Playwright
  tests; they are not on QA until the lead deploys. The F2 value change (152.54 instead of 159.82) is proven by the
  unit test and the QA before-state, not by a post-fix QA screenshot.
- One payment method (Netbanking) and one test bank were exercised. Cards, UPI and wallets were not.
- Email, SMS, WhatsApp and push deliveries were not observable.
- Only the paid GA path in India was walked end to end; reserved seating and cinema were out of scope.
