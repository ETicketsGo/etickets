# Real QA booking certification (Stripe test mode)

`ETicketsGoTests/QABookingCertificationTests.swift` runs the real booking lifecycle against QA.
**It creates QA records**, so it's skipped unless every gate below is set. Nothing in it can reach
PROD: it is hard-wired to `api-qa.eticketsgo.com`.

## Prerequisites (owner)

1. **Authorization:** written approval for QA booking mutations.
2. **Accounts:**
   - A disposable QA **customer** account, approved for QA writes.
   - Optionally, a QA **staff** account in the event's organisation, for the check-in steps.
3. **Event:** a disposable QA event priced in **USD or CAD**, with a paid ticket type on sale. INR routes to Razorpay, which has no app checkout yet.
4. **QA API configuration:**
   - Stripe is in **test mode**, with the webhook endpoint `POST /api/payments/webhooks/stripe` registered and its signing secret set.
   - Merge #469 first, so check-in refuses reversed bookings.

## Run

```sh
cd apps/customer-ios
TEST_RUNNER_ETG_QA_CERT=1 TEST_RUNNER_ETG_QA_ALLOW_BOOKING_MUTATIONS=1 \
TEST_RUNNER_ETG_QA_EMAIL=… TEST_RUNNER_ETG_QA_PASSWORD=… \
TEST_RUNNER_ETG_QA_CERT_EVENT_SLUG=… \
TEST_RUNNER_ETG_QA_STAFF_EMAIL=… TEST_RUNNER_ETG_QA_STAFF_PASSWORD=… \
xcodebuild test -project ETicketsGo.xcodeproj -scheme ETicketsGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:ETicketsGoTests/QABookingCertificationTests
```

When the test prints `ETG-CERT: … <url>`, open that URL and pay with Stripe's test card
`4242 4242 4242 4242` (any future date and CVC). The test waits up to `ETG_QA_CERT_WAIT_SECONDS`
(600 by default).

## What it proves

| #    | Step                  | Assertion                                                                       |
| ---- | --------------------- | ------------------------------------------------------------------------------- |
| 1    | Sign in               | Approved account, real `/auth/login`                                            |
| 2–3  | Event and quote       | Server availability and pricing; the total is greater than 0, in USD or CAD     |
| 4    | Hold                  | `PENDING_PAYMENT` with `holdExpiresAt`; priced the same as the quote            |
| 5    | Duplicate submission  | Same `idempotency-key` → same booking id                                        |
| 6    | Checkout              | `/pay` returns a `stripe.com` hosted page                                       |
| 8    | No early confirmation | Still `PENDING_PAYMENT` before anyone pays                                      |
| 7–8  | Webhook confirmation  | `CONFIRMED` only after Stripe's signed webhook                                  |
| 9–10 | Issuance              | Exactly one ticket for the booking, with a server-rendered QR the app will show |
| 11   | Check-in (with staff) | `SUCCESS`, then `DUPLICATE` for reuse, `INVALID` for a tampered code            |
| —    | Abandoned hold        | Released through `/cancel`; can't be paid afterwards                            |

## Covered in MOCK only (deterministic, no QA writes)

These are in `CheckoutHandoffTests` and `CheckoutRecoveryUITests`:

- A declined or cancelled payment, then retrying.
- Abandoned and expired holds.
- A payment that lands after the hold has expired.
- Duplicate provider callbacks.
- A connection drop while polling.
- Resuming after the app is terminated.
- A return link that is not proof of payment.

## Known backend gaps found during preparation (not fixed here)

- **Session lifetime:** the Stripe session has no `expires_at`, so it stays payable for 24 hours against a 10-minute hold. The expiry sweep releases Stripe holds without asking Stripe. A late payment then becomes a manual-refund discrepancy.
- **Currency:** the webhook checks the amount, not the currency.
- **Returning to the app:** `success_url` and `cancel_url` are fixed to the website. Returning to the app needs an opt-in `returnTo: 'app'` on `/pay`, plus a redirect from the web success and cancel pages.
