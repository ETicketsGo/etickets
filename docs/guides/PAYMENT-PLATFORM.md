# Global Payment Platform

ETicketsGo processes payments through a **multi-country, multi-provider, runtime-configurable**
platform. The booking engine never knows which gateway charges a customer — it asks the
orchestrator to create a payment for a currency, and configuration decides the rest. This
guide covers the architecture, the runtime configuration model, environments, operations,
and the safety rules the platform enforces.

> For the single-provider adapter mechanics (Stripe/Razorpay/PayPal/Square keys, webhooks),
> see [PAYMENT-INTEGRATION.md](./PAYMENT-INTEGRATION.md). This guide is about the platform
> _around_ those adapters.

---

## Architecture

```
Booking Engine
  → Payment Orchestrator        (retry / timeout / circuit-breaker / failover)
    → Payment Routing Policy    (country + currency + method → provider chain)
      → Provider Config Resolver (env-scoped, from the database)
        → Merchant Account Resolver
          → Provider Adapter    (Dummy | Stripe | Razorpay | PayPal | Square)
```

The booking engine contains **no provider-specific logic**. Layers live under
`apps/api/src/payments/`:

| Folder            | Responsibility                                                                |
| ----------------- | ----------------------------------------------------------------------------- |
| `domain/`         | Provider capabilities + normalized `PaymentProviderError` (retryability)      |
| `provider/`       | The `PaymentProvider` adapters (dummy/stripe/razorpay/paypal/square)          |
| `configuration/`  | Env resolution, routing policy, fail-closed validator, `PaymentConfigService` |
| `orchestration/`  | `CircuitBreaker`, `executeWithFailover`, registry, `PaymentOrchestrator`      |
| `admin/`          | Admin console backend (view/edit/enable/test, all audited)                    |
| `reconciliation/` | Reconciliation + settlement                                                   |
| `webhooks/`       | Multi-provider webhook routing                                                |

---

## Runtime configuration model

Configuration is **data, not code** — stored per `APP_ENV` in the database and editable
from the admin console (no deploy required). No raw secrets are ever stored: only public
identifiers and secret **references**.

| Model                   | Purpose                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentProviderConfig` | Per (env, provider): enabled, mode (DUMMY/TEST/LIVE), public key, secret refs, endpoint, timeout/retry/circuit-breaker controls, priority |
| `MerchantAccount`       | Per config: settlement account, optionally scoped to country/currency                                                                     |
| `PaymentRoute`          | Per env: (country, currency, method) → primary + failover provider, wildcard-aware, priority-ordered                                      |

**Routing** picks the most specific active route (exact country beats currency beats
method; `*` is a wildcard), then resolves the provider config and best merchant account.
The seed ships an editable default: `INR → Razorpay (failover Stripe)`, everything else
`→ Stripe`; local/dev/QA route to the dummy provider.

**Secret references.** A config stores e.g. `secretKeyRef = payments/stripe/live/secret-key`.
Your deployment resolves that reference from the secret manager and injects the resolved
secret into the raw environment variable the adapter reads (`STRIPE_SECRET_KEY`) at boot.
The platform never stores, logs, or returns raw secrets — and never stores card/PAN/CVV/
UPI-PIN/wallet/bank credentials.

---

## Environments

`APP_ENV` ∈ `LOCAL DEV QA UAT STAGING PRODUCTION`. Each environment configures its own
providers, modes, and routes independently. Guards:

| Guard                  | LOCAL | DEV | QA  | UAT | STAGING | PRODUCTION |
| ---------------------- | :---: | :-: | :-: | :-: | :-----: | :--------: |
| Dummy provider allowed |  ✅   | ✅  | ✅  | ❌  |   ❌    |     ❌     |
| LIVE mode allowed      |  ❌   | ❌  | ❌  | ❌  |   ✅    |     ✅     |
| Fails closed on boot   |   —   |  —  |  —  |  —  |   ✅    |     ✅     |

Templates: [`.env.example`](../../.env.example) plus one per environment
(`.env.local.example`, `.env.dev.example`, `.env.qa.example`, `.env.uat.example`,
`.env.staging.example`, `.env.production.example`).

---

## Fail-closed validation

`PaymentConfigService` validates the active environment on boot. In **STAGING/PRODUCTION**
any ERROR stops the boot. Rules (`configuration/payment-config.validator.ts`):

- Dummy provider must not be enabled outside LOCAL/DEV/QA.
- LIVE mode only in STAGING/PRODUCTION; PRODUCTION real providers must be LIVE (not TEST).
- An enabled real provider must have a non-placeholder public key + secret & webhook refs.
- Active routes must point only at enabled providers (primary and failover).
- STAGING/PRODUCTION must have ≥1 enabled provider and ≥1 active route.

The admin console applies the **same** validation before every edit: a change that would
leave a fail-closed environment invalid is rejected and rolled back.

---

## Orchestration: failover, retries, circuit breaking

`PaymentOrchestrator.createPayment` resolves the provider chain, then runs
`executeWithFailover`:

1. Skip a provider whose **circuit breaker** is OPEN.
2. Apply a per-attempt **timeout**.
3. **Retry** retryable errors (provider unavailable/timeout) with backoff.
4. A **terminal** error (card declined, invalid request) is not retried and does not fail over.
5. Exhausting a provider trips its breaker and **fails over** to the next candidate.

Refunds have provider affinity — they go to the gateway that captured the payment, with
retry/timeout/circuit protection but **no** cross-provider failover.

> Only provider adapters actually constructed in the process can be failed over to.
> Wiring every provider from secret-manager references is a follow-on once a secret
> manager is available; until then, an unconstructed routed provider is skipped in
> lower environments and fails closed in staging/production.

---

## Webhooks

Each gateway posts to a provider-scoped path so multiple providers can be live at once:

```
POST /api/payments/webhook/:provider     # stripe | razorpay | paypal | square
POST /api/payments/webhook               # legacy single-provider path (active provider)
```

The `WebhookRouter` resolves the adapter, assembles the signature material the provider's
scheme needs (a single header, or PayPal's transmission-header bundle), verifies inside the
adapter, then processes the settlement event. Settlement is **only** confirmed from a
verified webhook — never from a browser redirect.

---

## Operations (admin console → Payment Config)

- **View / edit** provider configs and routes per environment; validation banner shows
  ERRORs/WARNINGs live.
- **Test connection** runs a real provider health check.
- **Provider health** lists live health of constructed adapters.
- **Reconciliation** (`GET /admin/payments/reconciliation`) compares our payments against
  each provider's authoritative status over a window → matched / mismatched / unverifiable.
- **Settlement** (`GET /admin/payments/settlement`) summarises gross / refunded / net per
  provider and currency.

Every configuration change and reconciliation run is **audited**. Metrics:
`etg_payment_webhooks_total{provider,result}`, `etg_payment_reconciliations_total{result}`,
plus the existing `etg_payments_*` / `etg_gmv_minor_total`.

---

## Money integrity

- Money is integer **minor units** end to end; adapters convert to/from provider decimal
  formats using ISO-4217 exponents.
- Every booking keeps an **immutable fee + payment snapshot**.
- Every money transition (confirm, refund, payout) is **idempotent, auditable, and
  transaction-safe** — a re-delivered webhook never double-confirms or double-issues.
