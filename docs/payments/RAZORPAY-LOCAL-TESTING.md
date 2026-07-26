# Razorpay — Local Testing

How to run and smoke-test the India (Razorpay) path locally, in **Test Mode**, against a
regenerated test key. This exercises the real Razorpay SDK (v2.9.6) against Razorpay's
test environment — sandbox vs production is purely test vs live keys, same code.

---

## 1. Set the (regenerated) test keys in an ignored `.env`

Never commit these. Local `.env` is gitignored.

```dotenv
# Route INR bookings to Razorpay in this process:
PAYMENT_PROVIDER_NAME=razorpay

# Regenerated Test-Mode credentials (see RAZORPAY-DASHBOARD-SETUP.md §0):
RAZORPAY_KEY_ID="rzp_test_xxxxxxxxxxxxxx"        # PUBLIC
RAZORPAY_KEY_SECRET="xxxxxxxxxxxxxxxxxxxxxxxx"   # SERVER SECRET
RAZORPAY_WEBHOOK_SECRET="a-strong-secret-DIFFERENT-from-the-key-secret"  # SERVER SECRET, distinct

RAZORPAY_MODE=test                 # must match the rzp_test_ prefix, else boot fails
RAZORPAY_CURRENCY=INR
RAZORPAY_ROUTE_ENABLED=false        # see §3
RAZORPAY_CALLBACK_URL="http://localhost:3000/checkout/razorpay/callback"
RAZORPAY_CHECKOUT_NAME=ETicketsGo
RAZORPAY_CHECKOUT_DESCRIPTION=Event ticket purchase
```

Boot-time guards you will hit if misconfigured (`configuration.ts`):

- `RAZORPAY_MODE` must match the key prefix (`rzp_test_` ↔ `test`).
- `RAZORPAY_WEBHOOK_SECRET` must be **distinct** from `RAZORPAY_KEY_SECRET`.
- A selected Razorpay provider with any missing key **fails fast** with a key-named error.

The Order flow only activates when the booking is INR **and** `RAZORPAY_KEY_ID` is set;
otherwise the Stripe/mock path is used unchanged (so INR + mock still works for e2e).

---

## 2. Expose the webhook endpoint

Razorpay must reach `POST {API_URL}/api/payments/webhooks/razorpay`. Locally, tunnel it
(e.g. an ngrok-style HTTPS tunnel to `localhost:4000`) and register that URL as a
Test-Mode webhook (see the dashboard runbook). The endpoint is public but every event is
HMAC-verified against the raw body.

---

## 3. `RAZORPAY_ROUTE_ENABLED` behaviour

- **`false` (default):** Order + Checkout + verify + webhook issuance all work normally.
  Organizer settlement **release is BLOCKED** with *"Razorpay Route is not enabled;
  organizer payout is on hold."* No transfer is attempted — this is the expected local
  state unless you are specifically testing Route.
- **`true`:** release additionally requires an **active Linked Account** on the organizer;
  without one it is BLOCKED with *"No active Razorpay linked account for this organizer."*
  Route transfers only succeed against a real activated Test-Mode Linked Account.

---

## 4. Test-Mode payment instruments

Use Razorpay's Test-Mode instruments in Checkout:

- **UPI:** `success@razorpay` succeeds; `failure@razorpay` fails.
- **Cards:** a Razorpay test card (e.g. `4111 1111 1111 1111`), any future expiry, any CVV;
  Test-Mode OTP as prompted.
- **Netbanking / Wallets:** pick any bank/wallet in Test Mode and choose success/failure.

Amounts are **paise**: a ₹100 booking is `amountMinor = 10000`.

---

## 5. Send a signed test webhook (manual)

If you want to drive issuance without the browser, POST a body signed exactly as Razorpay
does — HMAC-SHA256 of the **raw body** with `RAZORPAY_WEBHOOK_SECRET`:

```bash
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_test123","order_id":"order_test123","amount":10000,"currency":"INR","notes":{"bookingId":"<BOOKING_ID>"}}}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST http://localhost:4000/api/payments/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: $SIG" \
  -H "X-Razorpay-Event-Id: evt_test_$(date +%s)" \
  --data-raw "$BODY"
```

Notes:
- `amount` (paise) **must equal** the booking total, or issuance is refused with
  `PAYMENT_AMOUNT_MISMATCH` (by design).
- `notes.bookingId` (or the Order `receipt`) is how the booking is resolved.
- The `X-Razorpay-Event-Id` header is the dedup key; reuse the same id to prove idempotency
  (the second delivery returns `duplicate: true`, no second issuance). Omit it and the
  dedup key becomes SHA-256 of the raw body.
- Send the **exact bytes** you signed — any reformatting breaks the HMAC.

---

## 6. Exact smoke-test sequence

1. **Booking** — create an INR booking (status `PENDING_PAYMENT`).
2. **Order** — call `createIntent`; confirm the response is the client-safe payload
   `{ keyId, orderId, amount, currency, prefill, callbackUrl }` and that it contains **no
   secret**. Confirm `Payment{ provider=razorpay, providerOrderId, status=PROCESSING }`.
   Re-call `createIntent` and confirm the **same** order is returned (retry-safe, no second
   payable order).
3. **Checkout** — pay via Test UPI/card in Razorpay Checkout.
4. **Verify** — `POST /api/bookings/:id/payments/razorpay/verify` with
   `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`. Expect
   `{ status: 'processing' }`, a `PaymentAttempt` (CREATED), and the payment id stored.
   Confirm **no tickets** issued yet.
5. **Webhook** — deliver `payment.captured` (or `order.paid`). The booking flips
   `PENDING_PAYMENT → CONFIRMED` and tickets are issued **once**.
6. **Issuance idempotency** — re-deliver the same event; expect `duplicate: true` / no
   second issuance.
7. **Settlement HELD** — confirm a `Settlement` for `(eventId, INR)` exists and is `HELD`
   (or `ELIGIBLE` once the event is `COMPLETED`). With Route disabled, attempting release
   yields `BLOCKED`.
8. **Refund** — issue a refund in the dashboard (or deliver `refund.processed`). Confirm
   the `Payment` moves to `PARTIALLY_REFUNDED`/`REFUNDED` and the settlement's `refundsMinor`
   increases (or, if already transferred, a Route reversal fires).
