# Organizer billing providers

How the platform takes payment from ORGANIZERS for a plan (Pro, Premium) or a credit pack.
This is not ticket money: billing shares no code path, table, webhook endpoint or signing secret
with ticket payments, payouts or settlement. It reuses only the secret manager and the
test/live key-safety rules.

| Organizer country | Provider                | Plan payment                         | Credit pack                     |
| ----------------- | ----------------------- | ------------------------------------ | ------------------------------- |
| US (USD)          | Stripe Billing          | Hosted Checkout, `mode=subscription` | Hosted Checkout, `mode=payment` |
| IN (INR)          | Razorpay Subscriptions  | Subscription `short_url` (mandate)   | Payment Link (hosted, one-time) |
| anything else     | none (checkout refused) |                                      |                                 |

The organizer's REGISTERED country picks the provider and the price, never the visitor's.

## The rules that hold whatever the provider says

- **A webhook is a claim.** Every event names a provider object (invoice, payment,
  subscription, checkout session, payment link, dispute). That object is fetched back over the
  provider's authenticated API, and only what the provider reports is applied.
- **A paid plan starts, renews or changes only with verified evidence**: the provider reports
  the payment PAID, for exactly the BillingPrice's amount (before tax) and currency, on a price
  ref that maps to that BillingPrice, for this account's provider customer, on a subscription the
  provider still reports live. The state machine (`subscription-state-machine.ts`) refuses
  anything else again on its own.
- **Replays are harmless.** `BillingWebhookEvent` is unique per (provider, event id). Under that,
  a payment applies once per (provider, payment ref) - checked inside the account lock - and a
  credit grant carries the ledger idempotency key `billing-pack:<provider>:<payment ref>`.
- **Order never moves a subscription backwards.** Status changes are decided from the
  subscription as the provider reports it NOW. A status-only event older than the newest provider
  time already applied (`OrganizerSubscription.providerStateAt`) is ignored as stale. A payment for
  a period already covered is recorded and changes nothing. An ended subscription is never
  re-activated by a late payment.
- **Disputes** (Stripe `charge.dispute.created`) flag the billing account (`disputedAt`,
  `disputeRef`) and write `BILLING_DISPUTE_OPENED` to the audit log. A dispute on a ticket charge
  belongs to no billing customer and is ignored here.
- **The redirect is never proof.** The organizer returns to
  `/organizer/billing?checkout=success`; the page polls `GET /organizations/:id/billing` and says
  "confirmed" only when the server reports the plan active.

## Processing: inline, retried by the worker

Billing events are low volume (a few per organization per month). Each delivery is verified on
the RAW bytes, stored, then processed in the same request, idempotently:

- applied or ignored -> `PROCESSED` / `IGNORED`, HTTP 200;
- refused for a reason (mismatch, unknown customer) -> `FAILED` with the reason, HTTP 200
  (a retry cannot change the answer; staff read it in the table);
- the provider API was unreachable -> stays `RECEIVED`, HTTP 200; the worker's `billing-sweep`
  job retries it from the stored payload (up to 8 attempts, then `FAILED`).
- a bad signature -> HTTP 400 and no row.

## Endpoints

| Route                                                         | Who                           |
| ------------------------------------------------------------- | ----------------------------- |
| `POST /api/billing/webhooks/stripe`                           | Stripe (signed)               |
| `POST /api/billing/webhooks/razorpay`                         | Razorpay (signed)             |
| `POST /api/organizations/:id/billing/checkout`                | owner                         |
| `POST /api/organizations/:id/billing/credit-packs/checkout`   | owner                         |
| `POST /api/organizations/:id/billing/portal`                  | owner (Stripe only)           |
| `POST /api/organizations/:id/billing/cancel`                  | owner (cancels at period end) |
| `GET /api/organizations/:id/billing/invoices/:invoiceId/html` | owner, manager                |

## Configuration (names only - never put values in documents)

| Variable                             | Meaning                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `BILLING_ENABLED`                    | `false` by default. `true` opens checkout.                                                   |
| `BILLING_PROVIDER`                   | `disabled` (default), `mock` (LOCAL/DEV/QA), `providers` (LOCAL/DEV/QA, test keys)           |
| `STRIPE_BILLING_SECRET_KEY`          | Stripe secret key for billing. Falls back to `STRIPE_SECRET_KEY`.                            |
| `STRIPE_BILLING_WEBHOOK_SECRET`      | Signing secret of the BILLING webhook endpoint. No fallback.                                 |
| `RAZORPAY_BILLING_KEY_ID`            | Razorpay key id for billing. Falls back to `RAZORPAY_KEY_ID`.                                |
| `RAZORPAY_BILLING_KEY_SECRET`        | Its secret. Falls back to `RAZORPAY_KEY_SECRET`.                                             |
| `RAZORPAY_BILLING_WEBHOOK_SECRET`    | Secret of the BILLING webhook. No fallback.                                                  |
| `RAZORPAY_BILLING_MANDATE_MAX_MINOR` | Largest recurring debit in paise without per-debit approval. Default `1500000` (INR 15,000). |
| `RAZORPAY_BILLING_UPI_AUTOPAY`       | `false` by default. Never assumed.                                                           |
| `BILLING_PAST_DUE_DAYS`              | Days PAST_DUE before GRACE. Default 7.                                                       |
| `BILLING_GRACE_DAYS`                 | Days of GRACE before EXPIRED. Default 7.                                                     |
| `BILLING_SWEEP_INTERVAL_MS` (worker) | Billing sweep cadence. Default 15 minutes.                                                   |
| `STRIPE_API_VERSION`                 | Optional pin, shared with the ticket adapter; unset = the SDK's pinned version.              |

Every credential above may instead be given as a secret reference in `<NAME>_REF` (for example
`STRIPE_BILLING_WEBHOOK_SECRET_REF=billing/stripe/test/webhook-secret`), resolved through
`SECRET_MANAGER`.

Boot refuses (`billingConfigurationErrors`): `BILLING_PROVIDER=providers` outside LOCAL, DEV
and QA; `BILLING_ENABLED=true` in STAGING or PRODUCTION; any LIVE key (`sk_live_`, `rk_live_`,
`rzp_live_`) for billing; `BILLING_ENABLED=true` with neither provider fully configured. A
production configuration needs the owner's approval and a later change.

## Setting up a QA sandbox (test mode)

### Stripe (test mode)

1. In the Stripe dashboard, TEST mode: create a Product per plan (Pro, Premium) and a recurring
   Price per plan and interval (USD, monthly and yearly) for EXACTLY the BillingPrice amounts.
   Tax behaviour: exclusive, or no tax (see Tax below). No trial on the Price.
2. Write each Price id to `BillingPrice.providerPriceRefTest` (`PATCH /api/admin/billing/prices/:id`,
   needs BILLING_MANAGE).
3. Billing Portal (Settings -> Billing -> Customer portal): allow updating payment methods and
   cancelling at period end. Turn OFF plan switching and proration (a plan change through the
   portal is refused on amount and lands as FAILED for staff).
4. Add a webhook endpoint `https://<qa-api-host>/api/billing/webhooks/stripe`, payload style
   "snapshot", events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.finalized`, `charge.dispute.created`. Put its signing
   secret in `STRIPE_BILLING_WEBHOOK_SECRET` (a DIFFERENT endpoint and secret from the ticket
   webhook).
5. Set `BILLING_PROVIDER=providers`, `BILLING_ENABLED=true` on the QA api (and the same values on
   the worker). Check: a US organizer owner can start a checkout; pay with `4242 4242 4242 4242`;
   the plan shows ACTIVE and an ETG-BIL invoice appears.

### Razorpay (test mode)

1. Ask Razorpay to enable **Subscriptions** on the account (it is not on by default). Until it is,
   checkout answers "Paying for a plan through Razorpay is not switched on for this account yet".
2. Create a Plan per BillingPrice (INR, `period` monthly or yearly, `interval` 1, amount EXACTLY
   the BillingPrice amount). Write each plan id to `BillingPrice.providerPriceRefTest`. Checkout
   refuses a plan whose amount, currency or period differs from the price.
3. Add a webhook `https://<qa-api-host>/api/billing/webhooks/razorpay` with its own secret
   (`RAZORPAY_BILLING_WEBHOOK_SECRET`), events: `subscription.authenticated`,
   `subscription.activated`, `subscription.charged`, `subscription.pending`,
   `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `payment.failed`,
   `payment_link.paid`.
4. The ticket webhook on the same account may also receive billing payments
   (`payment.captured` for a Payment Link). It IGNORES them (no booking id), and the billing
   endpoint ignores ticket payments (no `etg_purpose` note). Subscribing each endpoint only to its
   own events keeps the logs quiet.

### RBI e-mandate (India)

- Recurring debits run on an e-mandate (card, UPI Autopay or eNACH, whichever the account has
  enabled). The customer authorises it on the hosted page with an authentication transaction.
- A debit above the mandate limit (INR 15,000 by default) needs the customer's approval each
  time, so a price above `RAZORPAY_BILLING_MANDATE_MAX_MINOR` is refused at checkout with a clear
  message instead of failing every renewal.
- UPI Autopay is not assumed. The hosted page offers only what Razorpay has enabled on the
  account; `RAZORPAY_BILLING_UPI_AUTOPAY` records whether it is.
- Razorpay sends the RBI-required pre-debit notification before each mandate debit (confirm
  this on the account when Subscriptions is enabled).

## Lifecycle and the clock

`billing-sweep` (worker, every 15 minutes):

1. Ends what ran out: trial, grace, complimentary plan, a period set to cancel.
2. A provider plan whose period ended more than 3 days ago with no renewal: asks the provider
   first (a paid renewal we never heard about is applied), otherwise ACTIVE -> PAST_DUE.
3. PAST_DUE for more than `BILLING_PAST_DUE_DAYS`: -> GRACE for `BILLING_GRACE_DAYS`.
   GRACE then ends in EXPIRED (step 1).
4. Dunning: the owners of each PAST_DUE / GRACE subscription get `BILLING_PAYMENT_FAILED`
   (TRANSACTIONAL, email and console), once per stage: PAST_DUE, GRACE, GRACE_ENDING (two days
   before the end).
5. Retries billing webhook events left RECEIVED by a transient failure.

Provider events move the same states sooner: Stripe `past_due` / Razorpay `pending` -> PAST_DUE;
Stripe `unpaid` / Razorpay `halted` -> GRACE; `canceled` / `cancelled` / `completed` -> CANCELLED.

## Invoices and tax

Each verified payment issues an `OrganizerInvoice` with status PAID in the gapless
`ETG-BIL-<YEAR>-<SEQ>` series, once per provider document (`provider`, `providerInvoiceRef`).
The organizer opens it as printable HTML (print or save as PDF from the browser).

Tax: the invoice shows the tax the PROVIDER computed (Stripe Tax, if switched on). With none,
`taxMinor` is 0 and the invoice says "Tax not applied". Charging tax on plan invoices (GST in
India, US sales tax) is an OWNER DECISION still pending; nothing here invents a rate.

## Not in this change

- Plan changes through the provider (upgrade/downgrade with proration). Change plans by
  cancelling and buying the other plan, or through staff.
- Provider-side trials and promotion codes (trials are staff grants; discounts would mismatch).
- Refunds of plan payments (staff, in the provider dashboard; record a credit note).
- Production: live keys, live price/plan refs, the owner-approved boot configuration.
