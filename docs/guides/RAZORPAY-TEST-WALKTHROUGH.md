# Testing Razorpay on QA: card, UPI, netbanking

Everything below is ready in the codebase. What is missing is **credentials**, which only an
owner of the Razorpay account can produce — so this is written to be followed in one sitting
once you have them.

## Why QA cannot do this today

QA has no Razorpay keys at all:

```
RAZORPAY_KEY_ID          NOT SET
RAZORPAY_KEY_SECRET      NOT SET
RAZORPAY_WEBHOOK_SECRET  NOT SET
```

With none set, `PaymentsService` never takes the Razorpay branch — it falls through to the
mock provider. Anything "tested" in that state exercises a simulation, not Razorpay, and
would prove nothing about whether a real UPI collect request works.

This is deliberate rather than an oversight: the adapter is constructed lazily and **fails
fast** when a selected provider's secrets are missing, so a half-configured environment
refuses loudly instead of silently pretending.

## Step 1 — get test-mode keys

Razorpay Dashboard → **Settings → API Keys**, with the **Test Mode** switch on.
Generate a key pair. The id looks like `rzp_test_…`; the secret is shown **once**.

> A key that begins `rzp_live_` is a live key. The platform refuses to boot on a test key in
> production and, just as importantly, will happily take real money with a live one. Only
> `rzp_test_` belongs anywhere near QA.

## Step 2 — put them on QA

Never in git — Railway variables only, on the **api** service in the **QA** environment:

| Variable                  | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `RAZORPAY_KEY_ID`         | `rzp_test_…`                                                             |
| `RAZORPAY_KEY_SECRET`     | the secret shown once at generation                                      |
| `RAZORPAY_MODE`           | `test`                                                                   |
| `RAZORPAY_WEBHOOK_SECRET` | anything you choose — you set the same string in the dashboard at step 3 |

Then redeploy `api`. The adapter is built on first use from config, so the variables must be
live before a payment is attempted.

## Step 3 — register the webhook

Dashboard → **Settings → Webhooks → Add New Webhook**.

- **URL:** `https://api-qa-f580.up.railway.app/api/payments/webhooks/razorpay`
- **Secret:** the same `RAZORPAY_WEBHOOK_SECRET` you set above
- **Events:** `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`

The endpoint HMAC-verifies the **exact raw bytes** against `X-Razorpay-Signature` before it
will accept anything, so a mismatched secret is rejected rather than half-processed. Use a
distinct secret per environment: one shared across QA and production means a QA webhook can
move production bookings.

## Step 4 — the test credentials Razorpay provides

All of these work only in test mode and move no money.

**Cards** — any future expiry, any CVV, any name.

| Purpose              | Number                |
| -------------------- | --------------------- |
| Success              | `4111 1111 1111 1111` |
| Success (Mastercard) | `5267 3181 8797 5449` |
| Failure              | `4000 0000 0000 0002` |

For a 3-D Secure card the test OTP is shown on the challenge screen itself — do not guess it.

**UPI** — enter these as the VPA:

| Purpose | VPA                |
| ------- | ------------------ |
| Success | `success@razorpay` |
| Failure | `failure@razorpay` |

**Netbanking** — pick any bank; the test gateway shows an explicit **Success / Failure**
choice instead of a login.

**Wallets** — offered in test mode and settle immediately on selection.

## Step 5 — walk it

1. Open a **paid** event on QA (`qa.eticketsgo.com`) and book a ticket. The booking must be
   INR — routing is decided from the booking's own currency and country, never from anything
   the client sends, so a USD event will go to Stripe no matter what you pick.
2. Razorpay Checkout opens with card / UPI / netbanking / wallet tabs.
3. Pay with each method above in turn, one booking each.
4. After a success, check three things rather than one:
   - the booking reaches **CONFIRMED** and a ticket with a QR is issued;
   - the dashboard's **Webhooks** log shows a `2xx` for the QA endpoint;
   - a **failure** leaves the booking `PENDING_PAYMENT` and releases the hold — a payment
     path is only proven when you have watched it refuse.

## What this does _not_ prove

**Settlement.** Razorpay Route needs KYC and an activated account, and test mode does not
move money between real accounts. A green checkout says the charge worked; it says nothing
about whether an organizer would be paid.

**Live behaviour.** Test mode never declines for insufficient funds, never triggers a real
bank's 3-D Secure, and never produces a dispute. `PAYMENT_LIVE_ENABLED` remains the master
switch and stays `false` until a sandbox-to-live review is done deliberately.

**Cash.** Cash bookings never reach a provider at all — no Razorpay object exists for them,
by design. See the counter flow instead.
