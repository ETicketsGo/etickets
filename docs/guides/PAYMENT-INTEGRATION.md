# Payment Integration Guide

ETicketsGo charges through a single **`PaymentProvider`** abstraction. The MVP ships
three implementations behind it:

| Provider | `PAYMENT_PROVIDER_NAME` | SDK            | Region     |
| -------- | ----------------------- | -------------- | ---------- |
| Mock     | `mock` (default)        | — (in-process) | dev / test |
| Razorpay | `razorpay`              | `razorpay`     | India      |
| Stripe   | `stripe`                | `stripe`       | Global     |

The booking engine, inventory strategies, and `PaymentsService` are **provider-agnostic**
and were not changed to add real providers — everything below plugs in behind the
existing interface (`apps/api/src/payments/provider/payment-provider.interface.ts`).

> **Sandbox vs production is not a code change.** It is purely _test keys_ vs _live keys_.
> Set the test keys for sandbox, swap in the live keys for production. Nothing else differs.

---

## 1. How selection works

`PAYMENT_PROVIDER_NAME` (validated in `apps/api/src/config/configuration.ts`, default
`mock`) selects the active provider. The DI binding lives in
`apps/api/src/payments/payments.module.ts`:

```ts
{
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService, MockPaymentProvider],
  useFactory: selectPaymentProvider, // provider/payment-provider.factory.ts
}
```

`selectPaymentProvider` **constructs only the selected provider**. So Stripe/Razorpay keys
are never required unless you actually choose that provider — dev, test, and e2e keep
booting on the mock with zero gateway config. If you select a real provider but omit its
keys, construction **fails fast** with a clear error naming the missing variable.

The **mock remains the default**, so all existing unit tests and e2e are unaffected.

---

## 2. Webhook endpoint & signature header

There is **one** webhook endpoint for every provider:

```
POST /api/payments/webhook
```

`PaymentsController.webhook` reads the signature from the **active provider's**
`webhookSignatureHeader` (falling back to `x-payment-signature`), then hands
`{ rawBody, signature }` to `PaymentsService.handleWebhook` unchanged:

| Provider | Header read            |
| -------- | ---------------------- |
| mock     | `x-payment-signature`  |
| stripe   | `stripe-signature`     |
| razorpay | `x-razorpay-signature` |

`handleWebhook` only understands two outcomes — `payment.succeeded` (→ confirm booking,
issue tickets) and `payment.failed`. Each provider maps its own events onto these and
**rejects any other event type with `PAYMENT_WEBHOOK_INVALID` (HTTP 400)**. Signature
verification failures also throw `PAYMENT_WEBHOOK_INVALID` (400) before any booking state
is touched. The confirm path is idempotent and atomic (a re-delivered webhook never
double-issues tickets) — that logic was **not** modified by this integration.

> The raw request body is required for signature verification. The API is already
> configured with `rawBody: true`, so the exact bytes are verified — never a re-serialized
> body.

---

## 3. Razorpay (India)

### Configure

```bash
PAYMENT_PROVIDER_NAME=razorpay
RAZORPAY_KEY_ID="rzp_test_xxx"        # rzp_live_xxx in production
RAZORPAY_KEY_SECRET="xxxxxxxx"
RAZORPAY_WEBHOOK_SECRET="whsec-you-set-in-dashboard"
```

### Register the webhook

Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**:

- **URL:** `https://<your-api-host>/api/payments/webhook`
- **Secret:** the same value as `RAZORPAY_WEBHOOK_SECRET`
- **Events:** `payment.captured`, `payment.failed`

### Charge flow

1. `createPayment` calls `orders.create({ amount, currency, receipt: bookingId, notes.bookingId })`.
   - `amountMinor` maps directly to Razorpay's subunit amount (paise for INR).
   - `receipt = bookingId` is the idempotent business key; `notes.bookingId` travels with
     the payment so the webhook can resolve the booking without an extra fetch.
   - Returns `providerRef = order.id`, `clientActionUrl = order.id`.
2. **Frontend** opens Razorpay Checkout with the order id:

   ```js
   const rzp = new Razorpay({
     key: RAZORPAY_KEY_ID, // publishable key id
     order_id: clientActionUrl, // the order id returned by createPayment
     // amount/currency/prefill as needed
   });
   rzp.open();
   ```

   The browser redirect/callback is **never trusted** — settlement is confirmed only when
   Razorpay POSTs the signed `payment.captured` webhook.

3. `verifyWebhook` recomputes `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` and
   timing-safe compares it to the `x-razorpay-signature` header. It maps
   `payment.captured → payment.succeeded`, `payment.failed → payment.failed`, extracts
   `bookingId` from `payload.payment.entity.notes.bookingId` (or the order receipt) and
   `amountMinor` from the payment entity. The event `providerRef` is the **payment id**
   (`pay_…`) — that is what refunds need.
4. `refund` calls `payments.refund(paymentId, { amount, notes })` and returns
   `{ providerRef: refund.id, status }` (`processed`/`pending` → `COMPLETED`,
   `failed` → `FAILED`).

---

## 4. Stripe (global)

### Configure

```bash
PAYMENT_PROVIDER_NAME=stripe
STRIPE_SECRET_KEY="sk_test_xxx"       # sk_live_xxx in production
STRIPE_WEBHOOK_SECRET="whsec_xxx"
# Where Checkout redirects the buyer (optional; localhost defaults shown):
STRIPE_SUCCESS_URL="https://app.example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}"
STRIPE_CANCEL_URL="https://app.example.com/checkout/cancel"
```

### Register the webhook

Stripe Dashboard → **Developers → Webhooks → Add endpoint** (use the Stripe CLI for local):

- **URL:** `https://<your-api-host>/api/payments/webhook`
- **Signing secret:** copy into `STRIPE_WEBHOOK_SECRET`
- **Events:** `checkout.session.completed`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `checkout.session.async_payment_failed`

### Charge flow

1. `createPayment` creates a **Checkout Session** (`mode: 'payment'`, one line item at
   `unit_amount = amountMinor`, `customer_email`, `client_reference_id = bookingId`,
   `metadata.bookingId`, and `payment_intent_data.metadata.bookingId` so the PaymentIntent
   also carries the booking id). The `idempotencyKey` is passed as the SDK request option,
   so retries never create a second session.
   - Returns `providerRef = session.payment_intent` (or `session.id` if not yet set) and
     `clientActionUrl = session.url`.
2. **Frontend** redirects the buyer to `clientActionUrl`:

   ```js
   window.location.href = clientActionUrl; // Stripe-hosted Checkout page
   ```

   After payment the buyer lands on `STRIPE_SUCCESS_URL`, but that redirect is **not**
   trusted for fulfilment — the webhook is.

3. `verifyWebhook` calls `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)`.
   `checkout.session.completed` / `payment_intent.succeeded → payment.succeeded`;
   `payment_intent.payment_failed` / `checkout.session.async_payment_failed → payment.failed`.
   `bookingId` comes from metadata / `client_reference_id`; `amountMinor` from
   `amount_total` / `amount_received`. The event `providerRef` is the **PaymentIntent id**
   (`pi_…`) so the stored `Payment.providerRef` is refund-ready.
4. `refund` calls `refunds.create({ payment_intent, amount, reason })` and returns
   `{ providerRef: refund.id, status }` (`failed`/`canceled` → `FAILED`, else `COMPLETED`).

---

## 5. Reconciliation

Every provider surfaces a stable `providerRef`, which the platform persists and audits:

- **`Payment.providerRef`** — set to the intent/order ref at `createIntent`, then overwritten
  with the settled provider ref (`pay_…` / `pi_…`) on `payment.succeeded`. Match this against
  the provider dashboard's payment id to reconcile a booking ↔ a charge.
- **`PaymentAttempt`** rows — each webhook writes a `PaymentAttempt` (`SUCCEEDED`/`FAILED`)
  with `providerRef` and the full `rawEvent` payload, giving a per-delivery audit trail.
- **Audit log** — a confirmed booking records an `AuditService` entry
  `BOOKING_CONFIRMED` with `metadata.providerRef`.
- **Metrics** (`GET /api/metrics`, Prometheus) — `etg_bookings_confirmed_total` increments on
  each confirmed payment and `etg_payments_failed_total` on each failure. Compare these
  against provider dashboard totals to spot webhook drops.

To reconcile a batch: export settled payments from the provider, then match each provider
payment id to a `Payment.providerRef` (or the `PaymentAttempt.rawEvent`). A provider payment
with no matching confirmed booking indicates a missed/failed webhook delivery to retry.

---

## 6. Testing with sandbox

- **Local (no keys):** keep `PAYMENT_PROVIDER_NAME=mock`. The mock signs its own webhook and
  the `POST /api/payments/:bookingId/mock-pay` endpoint simulates success/failure end to end.
- **Razorpay sandbox:** use `rzp_test_…` keys and Razorpay's test cards/UPI. Point the
  Dashboard webhook at a tunnel (e.g. ngrok) → `/api/payments/webhook`.
- **Stripe sandbox:** use `sk_test_…` keys and `stripe listen --forward-to
localhost:4000/api/payments/webhook` (the CLI prints the `whsec_…` to use as
  `STRIPE_WEBHOOK_SECRET`). Complete a test Checkout with card `4242 4242 4242 4242`.
- **Automated tests:** the provider unit specs
  (`apps/api/src/payments/provider/*.spec.ts`) mock the SDKs — they never hit the network and
  cover create/verify/refund plus signature rejection and provider selection.

> **Note:** live sandbox/production verification requires real Razorpay/Stripe API keys and a
> publicly reachable webhook URL, so it cannot be exercised from CI or a sandbox without those
> credentials. The unit tests validate all mapping/verification logic offline.
