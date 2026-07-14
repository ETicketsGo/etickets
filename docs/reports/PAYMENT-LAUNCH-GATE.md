# Payment Launch Gate — GO / NO-GO

Point-in-time launch assessment for the production-binding payment platform. The
live report is generated on demand at `GET /admin/payments/launch-gate` (admin) and
aggregates readiness, matrices, certification evidence, and reconciliation status.

> **Rule:** No provider is declared ready for customer payments unless a **real
> sandbox certification has PASSED** and **every production safety control is
> satisfied** (payment-live readiness = GO).

---

## 1. Supported country / provider matrix (capability)

| Region            | Currencies      | Primary → Failover (seeded, editable) |
| ----------------- | --------------- | ------------------------------------- |
| India             | INR             | Razorpay → Stripe                     |
| US / CA / UK / AU | USD/CAD/GBP/AUD | Stripe                                |
| EU / SG / others  | EUR/SGD/…       | Stripe (PayPal / Square where routed) |
| Local / Dev / QA  | any             | Dummy                                 |

Providers implemented: **Stripe, Razorpay, PayPal, Square, Dummy.** Routing is
runtime data (`PaymentRoute`), editable per environment.

## 2. Merchant activation matrix

Per environment, tracked in `MerchantOnboarding` (DRAFT → … → ACTIVE). The live
report lists active-merchant counts per provider. **Current environment (LOCAL):
no real merchants onboarded** — expected; onboarding happens per target env.

## 3. Environment readiness matrix

| Env          | Dummy | Real providers   | Fail-closed | Notes                                          |
| ------------ | :---: | ---------------- | :---------: | ---------------------------------------------- |
| LOCAL/DEV/QA |  ✅   | optional sandbox |      —      | Dummy default; env secret backend allowed      |
| UAT          |  ❌   | TEST (sandbox)   |      —      | Cloud secret backend required                  |
| STAGING      |  ❌   | LIVE             |     ✅      | Boot fails closed on invalid config            |
| PRODUCTION   |  ❌   | LIVE             |     ✅      | `PAYMENT_LIVE_ENABLED` + readiness GO required |

## 4. Sandbox certification results

From `MerchantCertification` (latest PASS per merchant/provider). **Current: none in
LOCAL.** A recent PASS is a hard readiness requirement before live.

## 5. Secret-manager health

`GET /admin/payments/health` + launch-gate `secretManager.healthy`. LOCAL uses the
`env` backend (healthy); UAT/STAGING/PRODUCTION require a cloud backend.

## 6. Provider health

Per-provider live health check (built from resolved credentials). Surfaced in
readiness + launch-gate `providers[].failedChecks`.

## 7. Webhook readiness

Each provider posts to `/api/payments/webhook/:provider`; verification is
per-scheme. Launch-gate reports `webhookVerified` per provider (from ACTIVE
merchants with `webhookEndpointStatus = VERIFIED`).

## 8. Reconciliation readiness

Daily detection + triage queue. Launch-gate `reconciliation.ready` is true when
there are **0 open discrepancies**. Aging watched at `/admin/payments/finance/aging`.

---

## 9. Remaining risks

1. **No live credentials wired** — real Stripe/Razorpay/PayPal/Square keys must be
   placed in the target environment's cloud secret manager.
2. **No merchants onboarded / certified** in real environments yet.
3. **Cloud secret-manager SDKs** are feature-gated — install + verify per env.
4. `PAYMENT_LIVE_ENABLED` is **false** by default (correct until go-live).

These are deployment/credential steps, not platform gaps — every control to enforce
them exists and is tested.

## 10. GO / NO-GO

| Provider | Country/Currency  |           Status           | Blocking to reach GO                                    |
| -------- | ----------------- | :------------------------: | ------------------------------------------------------- |
| Dummy    | local             | **GO** (LOCAL/DEV/QA only) | —                                                       |
| Stripe   | US/USD, UK/GBP, … |         **NO-GO**          | live creds + merchant ACTIVE + PASS cert + readiness GO |
| Razorpay | IN/INR            |         **NO-GO**          | live creds + merchant ACTIVE + PASS cert + readiness GO |
| PayPal   | US/EU             |         **NO-GO**          | route + live creds + merchant ACTIVE + PASS cert        |
| Square   | US/CA/UK/AU/JP    |         **NO-GO**          | route + live creds + merchant ACTIVE + PASS cert        |

**Overall recommendation: NO-GO for live customer payments today** — the platform is
**launch-ready**, but no real provider has satisfied the go-live controls (real
credentials, ACTIVE merchant, PASS certification, readiness GO in PRODUCTION). This
is the correct, safe posture.

### Path to GO (per provider)

1. Provision the provider's live secrets in the environment's cloud secret manager.
2. [Promote](../guides/ENVIRONMENT-PROMOTION.md) the config to PRODUCTION (2 approvals).
3. [Onboard](../guides/MERCHANT-ONBOARDING.md) the merchant → ACTIVE, webhook VERIFIED.
4. [Certify](../guides/SANDBOX-CERTIFICATION.md) → PASS.
5. [Activate](../guides/PRODUCTION-ACTIVATION.md): `PAYMENT_LIVE_ENABLED=true`, enable
   the config, confirm `GET /admin/payments/launch-gate` shows **GO** for that provider.
