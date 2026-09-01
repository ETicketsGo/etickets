# Stripe (US) — what is built, and what is left

**Status: the code is complete and untested against Stripe.** Nothing here is a
development task. What remains is credentials, two dashboard settings, one organizer
onboarding flow, and a US event to buy a ticket for.

This mirrors `RAZORPAY-TEST-WALKTHROUGH.md`, and deliberately repeats its hardest-won
lesson: **do not copy credentials or settings out of a vendor's general documentation into
this file.** Ask the account. That mistake cost a blocked test session on the Razorpay side.

---

## What already exists

| Piece                      | Where                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| Checkout Session + intent  | `payments/provider/stripe-payment.provider.ts`                                   |
| Signature-verified webhook | `payments/webhooks/stripe/` (`POST /api/payments/webhooks/stripe`)               |
| Connect onboarding         | `payments/connect/organizer-connect.service.ts`                                  |
| Organizer-facing UI        | organizer console → **Payouts**                                                  |
| Buyer return pages         | `/checkout/success`, `/checkout/cancel`                                          |
| Routing                    | `routeProviderForBooking` — **USD → Stripe**, INR → Razorpay                     |
| Settlement                 | Separate Charges & Transfers; charge on the platform, `transfer_group` per event |

The buyer flow needs no Stripe-specific client code: `POST /bookings/:id/pay` returns
`clientActionUrl` and the payment page follows it, exactly as it does for Razorpay.

**A USD event now reaches this path.** Until the currency work landed, every ticket type
was created in INR regardless of venue, so nothing ever routed to Stripe. A ticket type
created at a US venue is now priced in USD, which is what makes any of this testable.

---

## Step 1 — credentials (yours to obtain)

From the Stripe dashboard in **test mode**:

| Variable                 | Value                       | Notes                                    |
| ------------------------ | --------------------------- | ---------------------------------------- |
| `STRIPE_SECRET_KEY`      | `sk_test_…`                 | **Never** `sk_live_` in QA or UAT        |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…`                 | Public; safe to expose                   |
| `STRIPE_WEBHOOK_SECRET`  | `whsec_…`                   | From the endpoint created in step 2      |
| `STRIPE_API_VERSION`     | the dashboard's API version | Optional; pins upgrades to be deliberate |

Validate the pair before configuring anything — a read-only call proves it authenticates
without moving money:

```
curl -u sk_test_...: https://api.stripe.com/v1/balance
```

Use a **distinct** webhook secret per environment. One shared with production lets a QA
webhook move production bookings.

> The API refuses to boot in a lower environment with an `sk_live_` key unless
> `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true`. A successful boot is itself evidence that no
> live credential is configured.

### What you do NOT need to set

`STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_CONNECT_RETURN_URL` and
`STRIPE_CONNECT_REFRESH_URL` are **derived** from `CUSTOMER_WEB_URL` and
`ORGANIZER_WEB_URL`, and the API now refuses to start a payment outside local development
if those are unset rather than falling back to localhost.

All four previously defaulted to `http://localhost:…`. That is the same defect that shipped
in `RAZORPAY_CALLBACK_URL` and would have returned a paying customer to a laptop **after
the money moved**. It was caught by reading rather than by a customer only because Stripe
has never had keys here. Set one of these only when a return must land somewhere other
than the obvious site.

---

## Step 2 — the webhook endpoint (Stripe dashboard)

Point it at the environment's API:

```
https://api-qa.eticketsgo.com/api/payments/webhooks/stripe
```

Subscribe to at least `checkout.session.completed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `charge.refunded` and `account.updated` — the last one is
what marks an organizer's Connect account charges-enabled without anyone re-checking by
hand.

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### Payload style must be **Snapshot**, not Thin

Stripe's newer "event destinations" offer a **thin** payload style, which carries only ids
and has no `data.object`. Every handler here reads the object, so a thin destination cannot
work — the endpoint now refuses it with a message naming the setting rather than throwing,
but it is still a failed delivery Stripe will retry on a backoff.

**Create one destination, set to Snapshot.** If a thin one exists, delete it.

### One destination per environment

Two destinations pointing at the same URL deliver every event twice. That is safe —
ingestion is idempotent on Stripe's event id, so the second is recorded as a duplicate and
does no work — but it doubles the traffic and makes the dashboard's activity graph lie about
volume. Keep one.

---

## Step 3 — Connect onboarding (per organizer)

**This gate will stop the first payment, and it is meant to.** A paid booking through a
Connect provider is refused with _"This organizer has not finished payment setup yet"_
until that organization has an `OrganizerPaymentAccount` with `chargesEnabled`. There is
nowhere to settle the money otherwise.

1. Sign in to the organizer console as the organization selling the US event.
2. **Payouts** → start onboarding. This calls Stripe for a hosted onboarding link.
3. Complete Stripe's test onboarding. In test mode it accepts obviously fake business
   details; use them — never real ones.
4. Stripe returns you to Payouts, and `account.updated` flips the account to
   charges-enabled.

---

## Step 4 — something priced in dollars

Routing reads the booking's own currency, so this is the part that makes it Stripe at all.

1. Create (or reuse) a venue with country **USA**.
2. Create an event at that venue, add a session, add a ticket type — **leave the currency
   field alone**. The organizer console labels the price field `Price ($)` because the
   currency is derived from the venue, and the server stores USD.
3. Publish it.

Confirm before going near a browser:

```
curl -s '<api>/api/public/events/<slug>' | grep -o '"currency":"[A-Z]*"' | head
```

USD here means the booking will route to Stripe. INR means the ticket type predates the
currency change — recreate it.

---

## Step 5 — walk it

Stripe's test cards are universal and not account-dependent, which is the one way this is
easier than Razorpay. `4242 4242 4242 4242`, any future expiry, any CVC.

1. Buy a ticket for the USD event. The payment page should send you to
   `checkout.stripe.com`, not to Razorpay.
2. Pay. Then check **three** things, not one:
   - the booking reaches **CONFIRMED** and a ticket with a QR is issued;
   - the Stripe dashboard's webhook log shows a `2xx` for this endpoint — the only evidence
     Stripe actually delivers, as opposed to our endpoint accepting;
   - a **declined** card (`4000 0000 0000 0002`) leaves the booking `PENDING_PAYMENT` and
     releases the hold. A payment path is only proven once you have watched it refuse.
3. Cancel out of Checkout and confirm you land on `/checkout/cancel` with the hold intact.

Then confirm the two things the browser cannot show you:

- **the redirect is not the authority** — close the tab immediately after paying and the
  booking must still confirm, from the webhook alone;
- **the transfer group is set** — the charge should carry `transfer_group: etg_event_<id>`
  in the Stripe dashboard, which is what a later settlement transfer keys off.

---

## What automated tests already cover

- `stripe-payment.provider.spec.ts`, `stripe-webhook.processor.spec.ts`,
  `organizer-connect.service.spec.ts` — the adapter, the webhook pipeline and onboarding,
  against a stubbed Stripe.
- `console-urls.spec.ts` — the redirect URLs throw rather than pointing at localhost.
- `booking-currency.spec.ts` / `ticket-type-currency.spec.ts` — a US venue produces USD,
  which is what routes to Stripe at all.

**No test drives Stripe's hosted Checkout**, for the same reason none drives Razorpay's:
it is a third party's markup, defended against automation, and a suite built on it fails
for reasons unrelated to this codebase. Steps 3–5 above are the human half, and the
dashboard's webhook log is the evidence for delivery.

---

## Not required for a test payment, but required before real money

- **Payouts to organizers.** Charges land on the platform and are transferred later; the
  settlement path exists and has never run against Stripe.
- **US sales tax.** `TAX_PROVIDER=manual` reads `TaxRule` rows. US sales tax is
  destination-based and per-jurisdiction — the seam for a tax service exists specifically
  so this does not get hardcoded. Do not invent rates.
- **`PAYMENT_PROVIDER`** stays at its default; routing is per-booking from currency, not a
  global switch. Setting it to `stripe` would send INR bookings there too.
