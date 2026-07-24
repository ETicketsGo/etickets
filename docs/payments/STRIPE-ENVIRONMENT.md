# Stripe — Environment & Configuration

Every `STRIPE_*` variable the API reads, where each one lives, and how they are
separated per environment. Defined and validated in
`apps/api/src/config/configuration.ts`; documented for operators in `.env.example`.

Stripe is only required when `PAYMENT_PROVIDER_NAME=stripe`. Sandbox vs production
is **purely test keys vs live keys** — the code is identical
(`stripe-payment.provider.ts` derives `testMode` from an `sk_test_` prefix).

---

## 1. Variable reference

| Variable                        | Purpose                                                                            | Secret?    | Side            | Notes                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------- | ---------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`             | Server API key used for every Stripe call (checkout, refunds, transfers, Connect). | **Secret** | **Server only** | `sk_test_…` (sandbox) / `sk_live_…` (prod). Never sent to any client. Required for Stripe.                                        |
| `STRIPE_WEBHOOK_SECRET`         | Verifies the signature of inbound webhooks against the raw body.                   | **Secret** | **Server only** | `whsec_…`. **Per-environment** and per-endpoint — each webhook endpoint has its own secret. Required for Stripe.                  |
| `STRIPE_PUBLISHABLE_KEY`        | Publishable key for client-side Stripe SDKs.                                       | Public     | Client-safe     | `pk_test_…` / `pk_live_…`. Safe to expose to approved clients; never a secret.                                                    |
| `STRIPE_API_VERSION`            | Pins the Stripe API version so dashboard/SDK upgrades are deliberate.              | Public     | Server          | Optional; when unset the installed SDK's pinned default is used. Set to the exact dashboard API version, e.g. `2025-08-27.basil`. |
| `STRIPE_SUCCESS_URL`            | Where hosted Checkout redirects on success.                                        | Public     | Server (config) | Supports Stripe's `{CHECKOUT_SESSION_ID}` placeholder. The redirect is **never** treated as proof of payment.                     |
| `STRIPE_CANCEL_URL`             | Where hosted Checkout redirects on cancel.                                         | Public     | Server (config) | —                                                                                                                                 |
| `STRIPE_CONNECT_CLIENT_ID`      | Connect OAuth client id (`ca_…`).                                                  | Public     | Server          | Only needed for the OAuth/Standard flow. Express/Custom accounts created via the API do **not** require it.                       |
| `STRIPE_CONNECT_ACCOUNT_TYPE`   | Connected-account type for organizer onboarding.                                   | Public     | Server          | `express` (default) \| `standard` \| `custom`. Express = Stripe-hosted onboarding + Express dashboard (login links supported).    |
| `STRIPE_CONNECT_RETURN_URL`     | Where Stripe returns the organizer after hosted onboarding.                        | Public     | Server          | —                                                                                                                                 |
| `STRIPE_CONNECT_REFRESH_URL`    | Where Stripe sends the organizer if an onboarding link expires.                    | Public     | Server          | —                                                                                                                                 |
| `STRIPE_SETTLEMENT_RESERVE_BPS` | Reserve withheld from each organizer transfer, in basis points (100 = 1%).         | Public     | Server          | Integer 0–10000, default `0` (no reserve). Never hardcoded; configurable per deployment.                                          |

### Server-only vs client

- **Server only (never leaves the API):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- **Client-safe:** `STRIPE_PUBLISHABLE_KEY` (and, if a client needs it, the success/
  cancel URLs). Everything else is server-side configuration.

---

## 2. Secrets come from the secret manager, never source control

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are the only two secret Stripe values.
They are injected at boot from:

- **Local/dev:** a git-ignored `.env` (see `.env.example`, which ships only commented
  placeholders).
- **Staging/production:** the deployment secret manager
  (`SECRET_MANAGER_PROVIDER = env | azure | aws | gcp`). The runtime payment config
  stores only **references** (e.g. `payments/stripe/live/secret-key`); the deployment
  resolves each reference and injects the resolved value into the raw environment
  variable the adapter reads. `SECRET_MANAGER_PROVIDER=env` is rejected in
  STAGING/PRODUCTION.

Never commit real keys. Boot fails closed in prod-like environments if a core secret
looks like a shipped placeholder or is too short (`assertProductionHardening`).

---

## 3. Per-environment separation (sandbox / staging / prod)

`APP_ENV` (`LOCAL | DEV | QA | UAT | STAGING | PRODUCTION`) selects which env-scoped
config applies. Rules:

- **Never mix test and live keys.** A single environment uses **either** the full
  test set (`sk_test_…`, `pk_test_…`, and a webhook secret from a **test-mode**
  endpoint) **or** the full live set — never a mix.
- **Webhook secrets are per-environment and per-endpoint.** The sandbox endpoint, the
  staging endpoint, and the production endpoint each have their own `whsec_…`. Copying
  a sandbox secret into production (or vice-versa) causes every event to fail
  signature verification.
- Live-classified keys are blocked in lower environments unless
  `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true`, and no live payment is accepted until the
  master switch `PAYMENT_LIVE_ENABLED=true`.
- Distinct Connect return/refresh/success/cancel URLs per environment (they point at
  that environment's frontend origin).

|                  | Sandbox (LOCAL/DEV/QA)  | Staging                    | Production              |
| ---------------- | ----------------------- | -------------------------- | ----------------------- |
| Secret key       | `sk_test_…`             | `sk_test_…`                | `sk_live_…`             |
| Publishable key  | `pk_test_…`             | `pk_test_…`                | `pk_live_…`             |
| Webhook secret   | test endpoint `whsec_…` | staging endpoint `whsec_…` | live endpoint `whsec_…` |
| Connect accounts | test `acct_…`           | test `acct_…`              | live `acct_…`           |
| Secret source    | git-ignored `.env`      | secret manager             | secret manager          |

---

## 4. Webhook endpoint & subscribed events

**Endpoint path (single, shared across all Stripe events):**

```
POST {API_URL}/api/payments/webhooks/stripe
```

Route = `payments/webhooks/stripe` (`stripe-webhook.controller.ts`) under the global
prefix `api` (`API_GLOBAL_PREFIX`, default `api`). The endpoint is public (Stripe is
unauthenticated) but **every** event is signature-verified against the raw body
before acceptance.

Subscribe **only** these events (the exact set the processor dispatches —
`stripe-webhook.processor.ts`):

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

Any other event type is durably recorded as `IGNORED` (received, no action) — nothing
is silently dropped — but there is no reason to subscribe to events we do not handle.

> `account.updated`, `transfer.*`, and `payout.*` are **Connect** events emitted on
> behalf of connected accounts; make sure the webhook endpoint is configured to
> receive **Connect** events (see dashboard setup).

---

## 5. Example (commented) local config

From `.env.example` — copy to a git-ignored `.env` and fill with **test** keys:

```dotenv
PAYMENT_PROVIDER_NAME=stripe
STRIPE_SECRET_KEY="sk_test_xxxxxxxxxxxxxxxxxxxxxxxx"      # SERVER-SIDE ONLY, secret
STRIPE_WEBHOOK_SECRET="whsec_xxxxxxxxxxxxxxxxxxxxxxxx"    # per-environment, secret
STRIPE_PUBLISHABLE_KEY="pk_test_xxxxxxxxxxxxxxxxxxxxxxxx" # public, safe to expose
STRIPE_API_VERSION="2025-08-27.basil"                    # pin the dashboard API version
STRIPE_SUCCESS_URL="http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}"
STRIPE_CANCEL_URL="http://localhost:3000/checkout/cancel"
STRIPE_CONNECT_ACCOUNT_TYPE="express"
STRIPE_CONNECT_RETURN_URL="http://localhost:3001/organizer/payouts?onboarding=return"
STRIPE_CONNECT_REFRESH_URL="http://localhost:3001/organizer/payouts?onboarding=refresh"
STRIPE_SETTLEMENT_RESERVE_BPS="0"
```
