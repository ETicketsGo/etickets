# Stripe Dashboard — Manual Setup

Step-by-step Stripe Dashboard configuration for the ETicketsGo account owner. Do this
in **sandbox / test mode first**, verify end-to-end, then repeat in **live mode**
after business verification.

Prerequisites: a Stripe account with **Connect enabled** (Settings → Connect), owner
access, and the API running with `PAYMENT_PROVIDER_NAME=stripe`.

> None of these steps put a secret in source control. Keys go into a git-ignored
> `.env` (local) or the deployment secret manager (staging/prod) — see
> `STRIPE-ENVIRONMENT.md`.

---

## 0. If a sandbox key was ever exposed — rotate it first

If a test secret key was committed, pasted in a ticket, or otherwise shared:

1. Dashboard → **Developers → API keys** (ensure the top-left toggle shows **Test
   mode**).
2. On the exposed **Secret key**, click **⋯ → Roll key** (roll immediately, no grace
   period if you can confirm nothing legitimate still uses it).
3. Copy the newly generated `sk_test_…`.
4. Put the new key **only** into the secret store — a git-ignored local `.env`
   (`STRIPE_SECRET_KEY=…`) or the deployment secret manager reference
   (`payments/stripe/test/secret-key`). Never commit it.
5. Restart the API so it picks up the rotated key, then confirm
   `GET /organizers/:id/payments/status` and a test checkout still work.

(Live-key rotation follows the same steps in **Live mode**; see `STRIPE-RUNBOOKS.md`
§ Key rotation for the zero-downtime overlap procedure.)

---

## 1. API keys

1. **Developers → API keys** (Test mode).
2. Copy the **Publishable key** (`pk_test_…`) → `STRIPE_PUBLISHABLE_KEY` (client-safe).
3. Reveal and copy the **Secret key** (`sk_test_…`) → `STRIPE_SECRET_KEY`
   (server-only, secret store).
4. Note the **API version** shown on the Developers → Overview page and set
   `STRIPE_API_VERSION` to that exact value so upgrades are deliberate.

---

## 2. Webhook endpoint

1. **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL:**
   ```
   {API_URL}/api/payments/webhooks/stripe
   ```
   (e.g. `https://api.staging.eticketsgo.example/api/payments/webhooks/stripe`).
3. **Listen to Connect events too:** select **"Events on Connected accounts"** in
   addition to your account's events (the `account.updated`, `transfer.*`, and
   `payout.*` events are emitted for connected accounts).
4. **Select events — choose ONLY these** (do not use "all events"):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.updated`
   - `charge.dispute.closed`
   - `account.updated`
   - `transfer.created`
   - `transfer.updated`
   - `transfer.failed`
   - `transfer.reversed`
   - `payout.paid`
   - `payout.failed`
5. **Add endpoint**, then open it and copy the **Signing secret** (`whsec_…`) →
   `STRIPE_WEBHOOK_SECRET` (secret store). This secret is **per-environment/per-endpoint** —
   the test endpoint's secret only verifies test events.

---

## 3. Payment methods

1. **Settings → Payments → Payment methods**.
2. Confirm **Cards** is enabled (required).
3. Optionally enable **Apple Pay** and **Google Pay** (the adapter advertises these
   capabilities). Apple Pay requires domain verification (Settings → Payments →
   Apple Pay → add your checkout domain).

---

## 4. Connect (marketplace) settings

1. **Settings → Connect → Settings**.
2. **Account type:** ensure **Express** is enabled (matches
   `STRIPE_CONNECT_ACCOUNT_TYPE=express`). Express gives Stripe-hosted onboarding and
   an Express dashboard (login links).
3. **Allowed countries for connected accounts:** restrict to **United States (US)**
   (organizers onboard with `country=US`).
4. **Capabilities requested:** the API requests `card_payments` and `transfers` per
   account automatically; no manual per-account action is needed.
5. **Redirect / onboarding URLs:** the API supplies the account-link
   `return_url` / `refresh_url` from `STRIPE_CONNECT_RETURN_URL` /
   `STRIPE_CONNECT_REFRESH_URL`, so no dashboard URL entry is required, but confirm
   those env values point at the correct environment's frontend.
6. **(Standard/OAuth only — not used with Express):** if you ever switch to Standard,
   copy the Connect **client id** (`ca_…`) → `STRIPE_CONNECT_CLIENT_ID`.

---

## 5. Branding, support & statement descriptor

Because the **platform is the merchant of record** (Separate Charges and Transfers),
the customer's card statement and receipts show the **platform's** branding.

1. **Settings → Business → Branding:** upload logo/icon and set brand colors (shown
   on hosted Checkout and Express onboarding).
2. **Settings → Business → Public details:** set the **support email**, support phone,
   and support URL.
3. **Settings → Payments → Statement descriptor:** set the descriptor customers see on
   their statement (keep it recognizable as ETicketsGo to reduce disputes).
4. Confirm the **return URLs** used by Checkout (`STRIPE_SUCCESS_URL` /
   `STRIPE_CANCEL_URL`) resolve to real pages in this environment.

---

## 6. Testing in sandbox

### Local webhooks with the Stripe CLI

Forward test events to the local API (default API port 4000):

```bash
stripe login
stripe listen --forward-to localhost:4000/api/payments/webhooks/stripe
```

`stripe listen` prints a temporary `whsec_…` — set that as `STRIPE_WEBHOOK_SECRET`
locally while the CLI is running. Trigger events with, e.g.:

```bash
stripe trigger checkout.session.completed
stripe trigger charge.refunded
stripe trigger account.updated
```

### Test cards

On hosted Checkout use Stripe's test cards, e.g.:

- `4242 4242 4242 4242` — succeeds.
- `4000 0000 0000 9995` — declined (insufficient funds).
- `4000 0000 0000 0341` — attaches but fails on charge (payment-failure path).

Any future expiry, any CVC, any postal code.

### Connect test accounts

1. Create an organizer, then `POST /organizers/:id/payments/stripe/account` and
   `…/stripe/onboarding-link`.
2. Complete Express onboarding with Stripe's test data (SSN `000-00-0000`, test bank
   routing `110000000` / account `000123456789`, phone `000-000-0000`, OTP `000000`).
3. Confirm `account.updated` flips the organizer to `chargesEnabled` (verify via
   `GET /organizers/:id/payments/status`).
4. Run a full booking → checkout → `checkout.session.completed` → ticket issuance,
   then complete the event and exercise approve → release to see a test
   `transfers.create`.

---

## 7. Going live

Only after sandbox verification passes end-to-end:

1. Complete Stripe **business verification / activation** (Settings → Business).
2. Switch the dashboard to **Live mode** and repeat **§1** (live `pk_live_…` /
   `sk_live_…`) and **§2** (a **live** webhook endpoint → new **live** `whsec_…`).
   Put the live secrets in the deployment secret manager, never in `.env`.
3. Repeat **§3–§5** in live mode (payment methods, Connect allowed countries = US,
   branding, statement descriptor, support details).
4. Flip the launch switches only when ready: `PAYMENT_LIVE_ENABLED=true`, and ensure
   `SECRET_MANAGER_PROVIDER` is a real backend (not `env`) in STAGING/PRODUCTION.
5. Smoke-test with a real low-value transaction and a real refund before opening
   sales.
