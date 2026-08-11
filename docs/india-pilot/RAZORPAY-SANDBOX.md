# Razorpay sandbox

What has to be true before an environment can take an Indian pilot payment, and who has to
make it true.

**No secret values appear in this document, and none may be committed anywhere.**

---

## The variable that did not exist

Readiness used to decide whether payment was possible like this:

```ts
paymentProviderConfigured: Boolean(
  process.env.RAZORPAY_KEY_ID || process.env.PAYMENTS_MOCK_MODE === 'true',
);
```

`PAYMENTS_MOCK_MODE` **is not a variable this system has.** It is absent from the config
schema, from every `.env`, from CI and from every deploy manifest. Its only effect anywhere
was to turn that check green — a flag whose sole power is to silence a payment warning.

`PAYMENT_PROVIDER` is a second trap: declared in the config schema, read by no runtime code.
The switch that actually selects a gateway is **`PAYMENT_PROVIDER_NAME`**. That is why a
local box with `PAYMENT_PROVIDER=mock` could take a mock payment while readiness insisted no
payment was possible — both statements were true, about different variables.

Readiness now reads the payment module's own model instead of inventing a parallel one.

---

## What each variable actually does

| Variable                  | Effect                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                 | `LOCAL \| DEV \| QA \| UAT \| STAGING \| PRODUCTION`. Unknown values resolve to LOCAL (the safest)         |
| `PAYMENT_PROVIDER_NAME`   | **The gateway.** `mock \| razorpay \| stripe \| paypal \| square`, default `mock`                          |
| `PAYMENT_PROVIDER`        | **Nothing.** Declared in the schema, read by no code. Do not use it to configure anything                  |
| `PAYMENTS_MOCK_MODE`      | **Nothing, and it no longer exists.** Removed — it was only ever read by the old readiness check           |
| `RAZORPAY_KEY_ID`         | Public key id. Sent to the browser to open Checkout. Required to create an order                           |
| `RAZORPAY_KEY_SECRET`     | Server-side only. Signs API calls and verifies the Checkout return signature                               |
| `RAZORPAY_WEBHOOK_SECRET` | Server-side only, and **must differ from the key secret** (boot refuses if equal). Verifies webhook bodies |
| `RAZORPAY_MODE`           | `test \| live`, cross-checked against the key prefix so the two cannot disagree                            |
| `RAZORPAY_CALLBACK_URL`   | Where Razorpay returns the browser after Checkout                                                          |
| `PAYMENT_LIVE_ENABLED`    | Master switch (ADR-028). Must be `true` before any real charge is accepted. Default `false`                |
| `RAZORPAY_ROUTE_ENABLED`  | Marketplace split settlement (Razorpay Route). Not required for a single-theater pilot                     |

### For a sandbox pilot, the minimum is

```
APP_ENV=UAT
PAYMENT_PROVIDER_NAME=razorpay
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=<rzp_test_… >
RAZORPAY_KEY_SECRET=<sandbox key secret>
RAZORPAY_WEBHOOK_SECRET=<a DIFFERENT string, chosen when creating the webhook>
RAZORPAY_CALLBACK_URL=https://<customer host>/checkout/razorpay/callback
```

Plus **one `PaymentRoute` row** for `currency=INR` pointing at `razorpay` — routing is stored
in the database, not in the environment, and its absence is reported separately as
`NO_INR_ROUTE`.

---

## What readiness says, per environment

`isDummyAllowed` and `isLiveAllowed` in `payments/configuration/payment-environment.ts` are
the existing policy. The readiness rules defer to them rather than restating them.

| Environment      | Mock gateway          | Razorpay test keys                             | Razorpay live keys                              |
| ---------------- | --------------------- | ---------------------------------------------- | ----------------------------------------------- |
| LOCAL / DEV / QA | **WARNING** — allowed | **READY** — sandbox                            | **BLOCKED** `RAZORPAY_LIVE_KEYS_IN_LOWER_ENV`   |
| UAT              | **BLOCKED**           | **READY** — the pilot rehearsal slot           | **BLOCKED** — live is not allowed here          |
| STAGING          | **BLOCKED**           | **READY**                                      | READY **only** with `PAYMENT_LIVE_ENABLED=true` |
| PRODUCTION       | **BLOCKED**           | **BLOCKED** `RAZORPAY_TEST_KEYS_IN_PRODUCTION` | READY **only** with the live switch on          |

**The mock gateway is never READY in any environment.** It confirms every booking it is
asked to, which is exactly what makes it useless as evidence — and reporting a pilot
environment green over a stub is the specific failure these rules exist to prevent.

### Reason codes

`PAYMENT_MOCK_ONLY` · `PAYMENT_PROVIDER_NOT_INR_CAPABLE` · `RAZORPAY_NOT_CONFIGURED` ·
`RAZORPAY_WEBHOOK_NOT_CONFIGURED` · `RAZORPAY_TEST_KEYS_IN_PRODUCTION` ·
`RAZORPAY_LIVE_KEYS_IN_LOWER_ENV` · `PAYMENT_LIVE_NOT_ENABLED` · `RAZORPAY_SANDBOX_READY` ·
`RAZORPAY_LIVE_READY`

None of them carries a fix path. Every one is platform configuration a theater cannot touch,
so each names ETicketsGo instead of offering a door the operator cannot open.

### The webhook secret is its own blocker

Razorpay's browser redirect is a **hint, not a result** — the tab can close, the network can
drop, and the redirect can be replayed. The webhook is what confirms a payment server-side.
Without a signing secret its signature cannot be verified, so every event is refused: orders
get created and never confirmed, after the customer's money has already left. That is worse
than not taking payment at all, so it blocks on its own even when the API keys are perfect.

---

## Owner actions

These need a Razorpay account and cannot be done from this repository.

1. **Razorpay Dashboard → Settings → API Keys**, in **Test Mode**. Generate a key pair. The
   id starts `rzp_test_`; the secret is shown once.
2. **Settings → Webhooks → Add New Webhook.**
   - URL: `https://<api host>/api/payments/webhook/razorpay`
   - Secret: choose a string that is **not** the API key secret (boot validation refuses them
     being equal).
   - Events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`,
     `payment.dispute.lost`.
3. **Store the three values as environment variables** on the target environment's services
   (API and worker). Never in git, never in a PR, never in a log.
4. **Create the INR payment route** — `POST /api/admin/payments/routes` with
   `{ currency: 'INR', provider: 'razorpay' }` for that environment, or via the admin
   Payments screen. Without it, checkout has no provider to select.

### Verifying without exposing anything

`GET /api/admin/payments/health` and `GET /api/admin/payments/live-readiness` report whether
credentials resolve. They report **presence, never values** — as does the cinema readiness
endpoint. If any of these ever prints a key, that is a defect to fix before anything else.

---

## What is already proven, and what is not

**Proven by unit tests, no credentials needed** — signature verification accepts a correct
HMAC and refuses a tampered one (`razorpay-payment.provider.spec.ts`), duplicate deliveries
no-op via an atomic claim, unhandled events are IGNORED rather than dropped, delivery
dead-letters after `MAX_ATTEMPTS`, and refunds map to COMPLETED/FAILED
(`razorpay-webhook.processor.spec.ts`).

**Not proven, and cannot be without sandbox credentials and a public HTTPS host** — that a
real Razorpay order can be created, that Razorpay's own signature format matches what the
verifier expects on live traffic, that its retry cadence behaves as assumed, and that a real
sandbox refund completes. Those are in
[STAGING-PILOT-REHEARSAL.md](./STAGING-PILOT-REHEARSAL.md) as an owner procedure.
