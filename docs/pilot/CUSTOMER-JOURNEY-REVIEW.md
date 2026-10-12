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

## Round L: mobile tap targets, sticky pay, sold-out notice, images, build id (2026-10-12)

Scope: the open items F7 (smaller observations) and the mobile findings of
`CROSS-BROWSER-CERTIFICATION.md`. F5 (seller and support contact) is NOT done: it needs a support
address the owner has confirmed. No pricing, fee, tax, payment, refund, receipt or invoice code
changed. Everything below is customer-web (plus two class-name edits in `packages/web-kit`).

"Before" is QA (https://qa.eticketsgo.com, 2026-10-12, Chromium 390x844 with a 4G profile: 1.6 Mbps,
150 ms), read only, as a guest. "After" is a local production build of this branch against a local
API (same script, same profile), because QA is deployed by the lead. The datasets differ, so a
before/after pair is only quoted where both were measured on the same build; the local "before"
build of `origin/main` was measured too.

| #   | Item                         | Before  | After                            | Change                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Tap targets                  | FAIL    | PASS (AA 2.5.8), PARTIAL (44 px) | Header logo, Sign in, language, city picker, quantity selects, Share, View photos, gallery arrows, FAQ rows, wishlist hearts, category chips, login tabs, footer links, "Change location" and the home-page policy links are 44 px tall on a phone. Nothing under 24 px is left (was 5 controls on the home page, 1 on Events). Desktop sizes are unchanged. |
| 2   | Sticky "Continue to payment" | FAIL    | PASS                             | A bar above the bottom navigation once tickets are chosen, only while the card's own button is off screen.                                                                                                                                                                                                                                                   |
| 3   | Sold-out notice              | FAIL    | PASS                             | "This event is sold out" (or "This date is sold out" when another date has tickets) at the top of the booking card. The empty price, guest form and Continue button are not shown.                                                                                                                                                                           |
| 4   | Guest revisit after cancel   | FAIL    | PASS                             | "You cancelled this booking", with a Browse events button.                                                                                                                                                                                                                                                                                                   |
| 5   | Hero time zone               | FAIL    | PASS                             | The key-facts line reads "22 Nov 2026, 1:57 am (GMT+5:30)", like the Sessions row.                                                                                                                                                                                                                                                                           |
| 6   | Images                       | PARTIAL | PARTIAL                          | Layout shift on the event page 0.331 to 0.000 and on login 0.187 to 0.004 (local, same-build comparison). Width and height on every image; the first card and the hero fetch at high priority. The home-page shift seen on QA (0.207) was not reproduced locally and is not fixed.                                                                           |
| 7   | axe                          | PASS    | PASS                             | Zero serious or critical at 390 and 1440 on home, events, a paid event, a sold-out event and login (WCAG 2.0/2.1/2.2 A and AA tags), including with tickets chosen so the sticky bar is on screen.                                                                                                                                                           |
| 8   | Build identifier             | FAIL    | PASS (after deploy)              | `<meta name="build-id">`, the footer ("Build 4f30b8b") and `/api/health` carry the short commit.                                                                                                                                                                                                                                                             |

### Root causes and fixes

1. **Tap targets.** Controls were sized for a mouse (`py-1.5`, `h-9`). Each now has `min-h-11` below
   the `sm` or `lg` breakpoint and keeps its old size above it. The header got `py-2` on a phone so
   the taller controls do not make it taller (60 px either way). Footer link lists lost their
   vertical gap on a phone because the links now carry the spacing. Still under 44 px but at least
   24 px: the footer logo (36 px), "Get directions" (42 px), and short footer words such as "FAQ" (29
   px wide, 44 px tall). WCAG 2.5.8 is met; 44 px is a usability aim.
2. **Sticky pay.** The ticket card ends in a price breakdown, an optional state field and (for a
   guest) two fields, so the button was several screens below the quantity box. `StickyContinue`
   shows the ticket count and the quoted total (never a stale total while a quote is loading) and
   presses the same handler, so the guest form is still validated and focus still goes to the first
   bad field. It is `lg:hidden`, sits at `3.5rem + env(safe-area-inset-bottom)` from the bottom,
   sets `scroll-padding-bottom` while shown so a focused field is not left under it, and leaves as
   soon as the card's own button is on screen. It is `aria-hidden` and out of the tab order: it is a
   shortcut for a finger, and a screen reader should not hear "Continue to payment" twice.
3. **Sold out.** `lib/event-availability.ts`: a date is sold out only when it has ticket types and
   every one has nothing available; the event is sold out when every upcoming date is. A closed or
   not-yet-open ticket type is not "sold out". Seated shows are left alone (their stock is on the
   seat map).
4. **Guest revisit.** Cancelling forgot the booking's token, so the booking link fell into the same
   screen as a stranger's browser. The browser now also remembers which booking ids it cancelled
   (ids only, no token, last 50) and the "not here" screen says what happened. A different browser
   still gets the access message; the test asserts both.
5. **Hero zone.** `EventFacts` called `dateTime` without the zone abbreviation that the Sessions row
   adds. `whenWithZone` adds it when the venue has a time zone.
6. **Images.** Measured on QA: no broken image on any page checked, and the no-image fallback (a
   lettered gradient in the same box) renders. The event page painted a 384 px skeleton, so the
   footer was in the first screen and was thrown to the bottom of a 6000 px page when the event
   arrived: that is the 0.331 shift. The skeleton is now a full screen tall. The event hero and the
   first card are eager with `fetchpriority=high`; the others stay lazy. `fetchpriority` is written
   in lower case because customer-web is on React 18, which warns about the camel-case spelling.
   The login page reserved 40 px for its sign-in tabs and nothing for the form, so the page grew
   twice (0.187); it now reserves both.
7. **axe.** New test, below.
8. **Build id.** Read at request time from the platform's commit variable (`BUILD_SHA`,
   `RAILWAY_GIT_COMMIT_SHA`, `SOURCE_COMMIT`, `GIT_COMMIT_SHA`), only if it is a hex string, first
   seven characters. It is a commit hash, not a secret. No Dockerfile build argument is needed. In
   local development no commit is set, so nothing is shown.

### Tests

- `apps/customer-web/lib/event-availability.test.ts`, `event-when.test.ts` and `build-id.test.ts`
  (vitest, 12 tests). Each was shown to fail when the code was broken.
- `apps/e2e/tests/customer-experience-round-l.spec.ts` (Playwright, 10 tests) on its own fixture
  events: tap-target sizes, the sticky bar (appears, sits above the navigation, validates the guest
  form, leaves when the real button shows, completes to payment), the sold-out notice, guest cancel
  and revisit (and that a second browser still sees the access message), the hero zone, image
  attributes, the build id, and axe at 390 and 1440.

### Evidence

Screenshots are in `C:\etg-wt\k-shots\l-cx\`. `before-qa-*` is QA on 2026-10-12: event top, tap
targets marked red (under 24 px) and orange (under 44 px), selected tickets with no bar, the
footer, and the old sold-out and cancelled screens from the K review. `after-local-*` is this
branch: the same views, the sticky bar, the sold-out notice and the cancelled revisit.

### Limitations

- Real Safari, iOS and Android were not tested (BLOCKED). Chromium with phone emulation only, so the
  safe-area inset was 0 in every run. The CSS uses `env(safe-area-inset-bottom)`, but a notch or a
  gesture bar was not seen.
- After-numbers are from a local build, not QA. QA shows nothing new until the lead deploys. The
  build id cannot be confirmed on QA until then, and it relies on Railway providing
  `RAILWAY_GIT_COMMIT_SHA` to the running web service (it does for the API; not yet seen here).
- The home-page shift on QA (0.207) was not reproduced locally and is not fixed. LCP on QA is
  dominated by API-served card images on a throttled link; the changes make the first one start
  sooner, but the gain was not measured on QA.
- The larger controls were checked at 390 px only.
- F5 (support contact) is untouched and still needs an owner-confirmed support address.
