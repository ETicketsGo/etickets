# Phase 3: native iOS checkout (technical design)

**Status:** design only. No payment code exists or should be written until this is approved.

**Principle:** the server decides every price, fee, tax, seat and ticket. The app sends the
customer's choices and shows the server's answers. It never computes a total or decides
availability, and it never issues or signs anything.

All references are to `apps/api/src` on `main`.

## 1. Flow

```
Event / show ──► choose tickets or seats ──► quote ──► create booking (hold) ──► pay ──► confirm (poll) ──► tickets
                     GET seats                POST       POST /bookings           POST           GET /bookings/:id      GET /tickets
                                              /bookings/quote  (idempotency-key)  /bookings/:id/pay
```

## 2. Ticket selection

- **What's for sale** comes from the existing reads:
  - `GET /public/events/:slug`: sessions and `ticketTypes` with `priceMinor`, `available` and `maxPerOrder`.
  - `GET /public/movies/:slug/shows`.
- **Steppers** are capped at `min(available, maxPerOrder)` as display only. The server enforces the real limit.
- **`GET /bookings/offers/:sessionId`** returns public discount codes only (`[{code,label}]`). Show them as suggestions.
- **Price preview** comes from `POST /bookings/quote` (public). The request is `{eventSessionId, items[{ticketTypeId, quantity, seatIds?}], couponCode?, buyerRegion?}`. The response is `FeeCalcResult`: subtotal, discount, the customer fee, the itemised tax lines and the total (`pricing/fee-calculator.ts:162`).
- **The quote is not a promise.** It is unsigned, expires never, holds nothing and doesn't check availability. Label it "estimated", re-quote when the selection changes (debounced), and treat `POST /bookings` as the source of truth.
- **The Expo app computes `estimatedSubtotal` on the client** (`customer-mobile/app/checkout.tsx`). The native app won't.

## 3. Seats and reservation locks

- **The seat map** is `GET /public/shows/:sessionId/seats?section=`.
  - `view:'overview'`: sections with counts and price ranges, but no rows. The customer picks a section first.
  - `view:'seats'`: rows of `{id, label, status, categoryId}`, plus `categories` with `ticketTypeId`, `colorHex` and `priceMinor`.
  - Seat states are `AVAILABLE`, `HELD`, `SOLD` and `BLOCKED`. Only AVAILABLE seats are selectable.
- **How seats are locked.** Postgres is the source of truth. `POST /bookings` claims seats with a conditional `UPDATE … WHERE status='AVAILABLE'`, inside the transaction that creates the booking, with a unique `(sessionId, seatId)` constraint (`inventory/seat-based.strategy.ts:69`).
  - If anyone took a seat first, the response is a 409 `BOOKING_INVENTORY_UNAVAILABLE`.
  - The app then reloads the map, keeps the seats that are still free, and asks the customer to replace the rest.
- **No client-side seat locking.** No optimistic locks, nothing in Redis.
- **Holds** last `BOOKING_HOLD_MINUTES` (default 10).
  - The hold expiry comes from `holdExpiresAt`. The countdown runs from that value and is re-synced from the server's time on every response, not from the device clock.
  - `POST /bookings/:id/extend-hold` (at most `BOOKING_HOLD_MAX_EXTENSIONS`) is offered when under 2 minutes remain.
  - The worker sweeps expired holds every 60 s. A seat may show HELD for up to a minute after release.

## 4. Booking lifecycle

| State                                          | How the app gets there                                                                                                                                 | What the app shows                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| (none)                                         | Selection and quote                                                                                                                                    | Estimated total                                     |
| `PENDING_PAYMENT`                              | `POST /bookings` with an `idempotency-key` header: one UUID per attempt, reused on retry. The response is `{id, status, holdExpiresAt, fees, payment}` | Hold countdown and the **server** `fees.totalMinor` |
| `CONFIRMED`                                    | A signature-verified webhook. Free events come back CONFIRMED immediately                                                                              | Confirmation and tickets                            |
| `EXPIRED` / `CANCELLED`                        | The hold lapsed, or `POST /bookings/:id/cancel` (PENDING only)                                                                                         | "Your hold ended", with an option to start again    |
| `PARTIALLY_REFUNDED` / `REFUNDED` / `DISPUTED` | Server-side                                                                                                                                            | Status only                                         |

- **Booking body:** `createBookingSchema` (`packages/validation/src/booking.ts:29`), i.e. items, buyer name and email, `buyerRegion` (India place of supply), and `paymentMethod: ONLINE`.
- **Retries:** on a network failure, retry with the same idempotency key. The server replays the stored response, so no second booking is created.
- **Phase 3 is signed-in only.** Guest booking (`x-anon-session`) is out of scope, because the guest routes have no verify, extend-hold or coupon calls (§9).

## 5. Pricing and fees

- **What the app does:** displays the itemised result (fees, `taxLines`, total) exactly as the server returns it.
- **Where the pricing is:** the coupon, the cinema policy (fee cap, maintenance charge, blocked sales), the fee bands, the 2% payment fee, India GST (CGST/SGST vs IGST by `buyerRegion`) and `feeMode` (`CUSTOMER_PAYS`, `ORGANIZER_PAYS`, `SHARED`) are all computed on the server (`pricing/pricing.service.ts`, `bookings.service.ts:404-531`).
- **Coupons:** `POST /bookings/:id/coupon {code|null}`, only while PENDING_PAYMENT and before payment starts. Re-render from the returned `fees`.
- **Blocked sales:** a 409 with `blockers` (cinema policy) shows the server's message and blocks checkout.

## 6. Checkout (Stripe / Razorpay)

- **Payment call:** `POST /bookings/:id/pay`.
- **Provider choice:** the server picks the provider by currency. INR goes to Razorpay (Stripe if Razorpay isn't configured); USD and CAD go to Stripe (`packages/shared-types/src/marketplace.ts:210`).
- **What the app gets:**

| Provider             | Response                                                                                                                                      | Native handling                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe** (USD/CAD) | `clientActionUrl` is the hosted Checkout URL                                                                                                  | Open in `ASWebAuthenticationSession`. Stripe's success/cancel URLs point at the **website** today, so the session can't auto-close: §9-B                                                                                                                       |
| **Razorpay** (INR)   | `clientActionUrl` is the order id, plus a `razorpay` block: `{keyId, orderId, amountMinor, currency, name, prefill, callbackUrl, upiEnabled}` | Option A: the Razorpay iOS SDK, fed **only** from that block, then `POST /bookings/:id/payments/razorpay/verify {razorpay_order_id, razorpay_payment_id, razorpay_signature}`. Option B: a server-hosted checkout page, which needs a backend change. See §9-A |
| Mock (dev/QA)        | A relative `/api/payments/:id/mock-pay`                                                                                                       | QA only: a POST through the normal client, behind the QA write guard                                                                                                                                                                                           |

- **Not on the device:** card data, PCI scope, client-side signatures and Stripe/Razorpay secrets. Only the public `keyId` the server sends is used.
- **Production writes stay blocked** in the PROD build until a reviewed change lifts `AppConfiguration.permits` for these routes only.

## 7. Payment confirmation

- **What confirms a booking:** only a verified webhook (or mock-pay, free or cash) confirms it. Razorpay `verify` returns `processing` or `confirmed` and **does not issue tickets**.
- **How the app learns of it:** by polling `GET /bookings/:id`.
  - Immediately, then every 2 s for 30 s, then every 5 s up to 3 minutes. It stops on CONFIRMED, EXPIRED or CANCELLED.
  - If it's still pending after that, the app shows "Payment received, confirming…" with Refresh, and the booking stays visible in history.
- **No realtime channel exists.** Push confirmation needs an APNs transport, because the server has only `fcm` and `expo` today (§9-D).
- **When the app returns to the foreground** with a PENDING booking, it resumes polling.

## 8. Ticket issuance

- **When tickets exist:** the server creates them in the confirmation transaction, and signs the QR code when tickets are read.
- **What the app does:** reloads `GET /tickets` and shows the server-rendered `qrDataUrl` under the presentability rules that already exist (Phase 2B). The offline copy refreshes on the next load.

## 9. Cancellation and refunds

- **Cancel:** `POST /bookings/:id/cancel` works only while PENDING_PAYMENT. Paid bookings get a 409 pointing to refunds.
- **Refund request:** `POST /refunds {bookingId, reason, ticketIds?}` creates a REQUESTED refund that an organizer or admin approves.
- **Eligibility** is decided by the server: refunds enabled, before the cutoff (default 48 h), and a cancelled show bypasses the rules. Fees are refunded only when the show was cancelled.
- **Status:** `GET /refunds/booking/:id` shows REQUESTED, APPROVED, REJECTED, PROCESSING, COMPLETED or FAILED.
- **The app shows the server's eligibility answer.** It doesn't compute refund amounts.

## 10. Gaps needing decisions before build

| #   | Gap                                                                                                                             | Options                                                                                                                                                 | Recommendation                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A   | **No native Razorpay path** (INR, the main market). The Expo app rejects it today                                               | (1) The Razorpay iOS SDK, a third-party package; (2) a server-hosted Razorpay page opened in `ASWebAuthenticationSession`, which needs a backend change | Decide with the payments owner. Option 1 is the standard Razorpay integration and needs package approval |
| B   | **Stripe and Razorpay return to web URLs.** There's no app return URL, and no `apple-app-site-association` file in customer-web | Universal links for `/checkout/success` and the Razorpay callback, or a per-client `returnUrl` in `/pay`                                                | Universal links. The Razorpay `callbackUrl` page doesn't exist in customer-web yet either                |
| C   | **Guests can't verify, extend or apply coupons**                                                                                | Signed-in only for Phase 3, or new guest routes                                                                                                         | Signed-in only                                                                                           |
| D   | **No APNs push transport**                                                                                                      | Polling only, or add APNs (or FCM for iOS)                                                                                                              | Polling in Phase 3, push in Phase 4                                                                      |
| E   | **The quote is unsigned and doesn't check availability**                                                                        | Accept it and treat create as truth, or add server quote validation                                                                                     | Accept it. The design above handles the 409                                                              |

## 11. Test plan

- **Unit tests**, with a stub transport:
  - Request bodies match the schemas.
  - Idempotency keys are reused on retry.
  - A 409 re-selects seats.
  - The hold countdown follows `holdExpiresAt`.
  - Polling ends correctly in each terminal state.
  - No pricing arithmetic appears in the app module (lint/grep check).
- **QA, approved test account, mock or test-mode providers:**
  - Create, then hold, then pay (mock), then confirm, then tickets.
  - Hold expiry.
  - Cancel.
  - A refund request.
- **UI tests:** the selection, checkout and confirmation screens against MOCK.
- **The PROD write guard stays in place** until a separate approval.
