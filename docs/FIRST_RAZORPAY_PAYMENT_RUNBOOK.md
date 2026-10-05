# First Razorpay payment runbook

How to watch one real Indian payment go through, and how to tell which step failed if it does
not. Written to be followed with a terminal open, not read afterwards.

Traced from source at `main = c77a9cd`. Where this contradicts an earlier document, this one was
read off the code.

---

## 1. The path a payment takes

| #   | Step                                   | Where                                                              | Evidence it happened                                                                                                                        |
| --- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Buyer prices a basket                  | `POST /api/bookings/quote` → `PricingService.quote`                | HTTP 200 with `fees.totalMinor`                                                                                                             |
| 2   | Booking created, `PENDING_PAYMENT`     | `BookingsService`                                                  | `Booking.status`, no `reference` yet                                                                                                        |
| 3   | Razorpay order created                 | `RazorpayOrderService.createOrder` → `payload()`                   | `razorpay order ready order=… booking=… amountMinor=… currency=INR` **(on `main` since #215)**                                              |
| 4   | Browser hands off to Razorpay Checkout | client, with `keyId` + `orderId`                                   | `PaymentAttempt` row, `Payment.status`                                                                                                      |
| 5   | Buyer pays                             | Razorpay                                                           | Razorpay dashboard payment id `pay_…`                                                                                                       |
| 6   | Razorpay posts the webhook             | `POST /api/payments/webhooks/razorpay`                             | `[Request] {"path":"/api/payments/webhooks/razorpay","status":200,…,"correlationId":…}`                                                     |
| 7   | Signature verified                     | `RazorpayPaymentProvider.verifySignedEnvelope`                     | a 200 at all; a bad signature is `400 PAYMENT_WEBHOOK_INVALID`                                                                              |
| 8   | Event stored, deduped                  | `RazorpayWebhookService.ingest`                                    | `WebhookEvent` row, `processingStatus=RECEIVED`                                                                                             |
| 9   | Event dispatched                       | `RazorpayWebhookProcessor.process` → `dispatch`                    | `razorpay webhook processed event=payment.captured providerEventId=…` **(on `main` since #215)**; `WebhookEvent.processingStatus=PROCESSED` |
| 10  | Amount checked against the booking     | `PaymentsService.confirm`                                          | refuses with `PAYMENT_WEBHOOK_INVALID` + an audit row `PAYMENT_AMOUNT_MISMATCH`                                                             |
| 11  | Booking → `CONFIRMED`, atomically      | `prisma.$transaction` in `confirm`                                 | `Booking.status=CONFIRMED`, `confirmedAt` set                                                                                               |
| 12  | Public reference assigned              | `BookingReferenceService.assign`                                   | `Booking.reference` = `ETG-IN-2026-…`                                                                                                       |
| 13  | Receipt issued, same transaction       | `ReceiptsService.issueForBooking`                                  | `Receipt` row                                                                                                                               |
| 14  | Inventory settled, tickets minted      | experience strategy → `tx.ticket.create`                           | `Ticket` rows with `serial` + `nonce`, `status=ACTIVE`                                                                                      |
| 15  | Confirmation notification queued       | `NotificationService.sendCritical` **inside the tx**               | `Notification` row, `type=BOOKING_CONFIRMED`                                                                                                |
| 16  | Settlement accrued                     | `settlements.onPaymentSucceeded(eventId)` **after commit, `void`** | `Settlement` ledger movement                                                                                                                |

### Idempotency boundaries, and why they are where they are

- **Webhook dedup** — `WebhookEvent` unique on `(provider, providerEventId)`, taken from the
  `X-Razorpay-Event-Id` header or, absent that, a SHA-256 of the raw body. A redelivery whose
  row is already `PROCESSED` or `PROCESSING` returns `{duplicate: true}` and does nothing.
- **Processing claim** — `updateMany` from `RECEIVED|FAILED` → `PROCESSING` with
  `attempts: {increment: 1}`. Only the delivery that wins the claim dispatches.
- **Confirmation claim** — `updateMany` on `Booking` from `PENDING_PAYMENT` → `CONFIRMED`.
  **This is the one that matters for money:** only the delivery that flips the status issues
  tickets, so tickets cannot be double-issued no matter how many webhooks arrive.
- **Dead letter** — after `MAX_ATTEMPTS` the row goes `DEAD`; the worker sweep
  (`processPending`) retries `FAILED` rows under the cap.

Note step 16 is `void`-ed and runs **after** the transaction. A settlement accrual can therefore
fail without failing the booking — deliberate, but it means finance can lag a confirmed booking.

---

## 2. The webhook contract, as the code actually implements it

|              |                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| URL          | `https://api.eticketsgo.com/api/payments/webhooks/razorpay` (plural `webhooks`)                       |
| Signature    | HMAC-SHA256 of the **exact raw body**, header `X-Razorpay-Signature`, compared with `timingSafeEqual` |
| Secret       | `RAZORPAY_WEBHOOK_SECRET`; config validation refuses it being equal to `RAZORPAY_KEY_SECRET`          |
| Dedup header | `X-Razorpay-Event-Id`, when present                                                                   |
| Throttling   | exempt (`@SkipThrottle`) — a provider delivers from few addresses and a 429 is a late ticket          |

### Events — a correction to an earlier claim

`PRODUCTION_TRANSACTION_CERTIFICATION.md` §20.4 said to subscribe **only** `payment.captured`
and `payment.failed`, and that anything else is rejected with a 400. **That is wrong for this
endpoint.** It describes `RazorpayPaymentProvider.mapEventType`, which serves the _generic_
`/payments/webhook` route. The dedicated route goes through `RazorpayWebhookProcessor.dispatch`,
which handles a much larger set and **rejects nothing**:

| Event                                                                                   | Outcome                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `payment.captured`, `order.paid`                                                        | **processed** — confirms the booking                                       |
| `payment.failed`                                                                        | **processed** — records the failure                                        |
| `refund.processed`                                                                      | **processed** — moves the ledger                                           |
| `refund.created`                                                                        | ignored (accepted, not yet paid — counting it double-counted every refund) |
| `refund.failed`                                                                         | **processed** — marks our refund FAILED for manual follow-up               |
| `payment.dispute.created` / `.won` / `.lost`                                            | **processed**                                                              |
| `transfer.failed`, `transfer.reversed`                                                  | **processed** (only meaningful once Route is on; it is not)                |
| `payment.authorized`, `transfer.processed`, `settlement.processed`, `settlement.failed` | ignored, recorded                                                          |
| anything else                                                                           | ignored, recorded — never dropped silently                                 |

**So subscribe the events you want acted on.** Had the earlier instruction been followed,
refunds and disputes would never have reached us. An unrecognised event costs a row, not an
error.

### Proven by tests, not assumed

`razorpay-webhook.service.spec.ts` and `razorpay-webhook.processor.spec.ts` (21 tests) cover:
valid signature accepted; bad, empty, and wrong-body signatures each refused **with nothing
written**; payload-hash fallback when no event id; redelivery not processed twice; the atomic
claim lost → no-op; `payment.captured` → confirm; `payment.failed` carrying its reason;
`order.paid` resolved from receipt/notes; refund counted once; dispute synced; unknown event
IGNORED; dead-letter after max attempts; and **a capture naming no booking IGNORED rather than
guessing one**.

Out-of-order is covered at the service level: `payments.service.spec.ts` has _"does not tell
somebody holding tickets that their payment failed"_ — a late `payment.failed` after
confirmation records the attempt and changes nothing else.

---

## 3. Watching the first real payment

Have these ready before the buyer starts. Substitute the ids as they appear.

**Before:** note the booking id from the checkout response, and the Razorpay order id
(`order_…`) from the payment payload.

```bash
# 1. The order was created (merged in #215; present once the API is deployed)
railway logs --service api --environment PROD | grep "razorpay order ready"

# 2. The webhook arrived and authenticated (a 200 at all means the signature passed)
railway logs --service api --environment PROD | grep "payments/webhooks/razorpay"

# 3. What we decided to do with it
railway logs --service api --environment PROD | grep "razorpay webhook"
```

Then confirm state, which is authoritative whatever the logs say:

| Question                          | Where to look                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Did the webhook land and process? | `WebhookEvent` where `providerEventId` = the `X-Razorpay-Event-Id`; expect `processingStatus=PROCESSED` |
| Is the booking confirmed?         | `Booking.status=CONFIRMED`, `confirmedAt` and `reference` both set                                      |
| Were tickets issued?              | `Ticket` rows for the booking, `status=ACTIVE`, one per unit/seat                                       |
| Is there a receipt?               | `Receipt` row for the booking                                                                           |
| Was the buyer told?               | `Notification` row `type=BOOKING_CONFIRMED`, and its delivery state                                     |
| Did finance move?                 | `Settlement` for the event                                                                              |
| Any mismatch?                     | `AuditLog` action `PAYMENT_AMOUNT_MISMATCH` — if this exists, **stop**                                  |

### What is NOT observable

- **These two log lines are merged but not yet DEPLOYED.** Until production runs a build that
  includes them, there is no positive log line for order creation or successful webhook
  processing, and `IGNORED` is indistinguishable from "never arrived". Until then, the database
  state below is the only evidence.
- There is no single correlation id spanning Razorpay → booking → ticket → notification →
  finance. The join key is the **booking id**, present on every row above; the Razorpay payment
  id reaches us as `Payment.providerRef` and in `PaymentAttempt.rawEvent`.
- `settlements.onPaymentSucceeded` is fire-and-forget, so finance lagging a confirmed booking is
  expected briefly and is not evidence of failure on its own.

---

## 4. If it goes wrong

| Symptom                                                 | Most likely cause                                        | First safe action                                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Razorpay says captured; booking still `PENDING_PAYMENT` | webhook never delivered, or the signature does not match | Check for a `WebhookEvent` row. **No row = not delivered or signature failed.** Compare `RAZORPAY_WEBHOOK_SECRET` with the dashboard value. Do **not** confirm by hand. |
| `400 PAYMENT_WEBHOOK_INVALID` in the log                | secret mismatch, or body altered in transit              | Same check. The secret is the only thing a real purchase can prove.                                                                                                     |
| `WebhookEvent` is `FAILED` with attempts climbing       | a downstream error                                       | Read `errorMessage`. The worker sweep retries under the cap; let it.                                                                                                    |
| `WebhookEvent` is `IGNORED` for `payment.captured`      | the payload named no booking we could resolve            | The capture is real and unattributed. **Stop.** Reconcile by hand against the Razorpay payment's `notes`.                                                               |
| `PAYMENT_AMOUNT_MISMATCH` audit row                     | provider amount ≠ booking total                          | **Stop.** Tickets were deliberately not issued. Do not refund until the difference is understood.                                                                       |
| Booking confirmed, no tickets                           | strategy settled fewer units than expected               | The transaction rolls back and throws, so this should be impossible. If seen, treat as a P0 and stop.                                                                   |
| Confirmed, no notification                              | email transport, not the payment                         | Payment is fine. Check the `Notification` row's delivery state; the ticket exists regardless.                                                                           |

**Do not issue a refund as a first response to anything above.** A refund on top of a state
nobody has established yet turns one problem into two reconciliations.

---

## 5. What this runbook cannot tell you

The webhook secret is the one link only a real paid purchase can close: we generated it and
typed it into the dashboard by hand, Razorpay never returns it, and a mismatch is silent — the
payment succeeds and the booking stays `PENDING_PAYMENT`. **Watch the first purchase through to
`CONFIRMED` before taking a second.**
