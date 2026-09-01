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

## Step 4 — what THIS account can take a payment with

> **Read this before copying a card number from anywhere.**
>
> An earlier version of this page listed `4111 1111 1111 1111` and the UPI id
> `success@razorpay`, taken from Razorpay's general documentation. **Neither works on the
> QA account.** Checkout answers _"International cards are not supported"_ for that card,
> and UPI is not switched on at all. Nothing was broken — the enabled methods are a
> per-account setting, and no documentation page can know what a given merchant has turned
> on. Writing them down here guaranteed these instructions would eventually be wrong.

So ask the account instead of this file:

```
RAILWAY_TOKEN=<qa token> node scripts/payments/razorpay-methods.mjs
```

It calls `/v1/preferences` — the same public preflight Razorpay Checkout itself runs before
drawing its method list — so what it prints is exactly what the buyer will be offered, and
it stays right when the account changes.

**As of the last run against QA:**

| Method     | Enabled | Detail                                |
| ---------- | ------- | ------------------------------------- |
| Netbanking | ✅      | 40 banks                              |
| Wallet     | ✅      | airtelmoney, mobikwik, olamoney       |
| Card       | ✅      | MAES, MC, RUPAY, VISA — domestic only |
| UPI        | ❌      | not enabled on the account            |
| EMI        | ❌      | not enabled on the account            |

**Use Netbanking.** Pick any bank and the test gateway shows an explicit **Success /
Failure** choice instead of a login — no card number, no account setting, and it exercises
the identical order → webhook → confirmation path. A wallet does the same.

**Cards need one of two things first:** either enable international payments in the
Razorpay dashboard, or use a domestic test card. Domestic test numbers are listed **in the
Razorpay dashboard itself**, which is the only source that reflects your account — this
file deliberately no longer quotes any, because that is the mistake it is correcting.

**UPI needs enabling** — Razorpay Dashboard → Settings → Configuration → Payment Methods —
before any UPI id is worth trying.

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
