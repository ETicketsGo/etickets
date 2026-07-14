# Merchant Onboarding Guide

Onboard and activate a real merchant/provider per environment via the admin console
(`/admin/merchant-onboarding`) or the API (`/admin/payments/onboarding/*`). Only
provider account IDs and secret **references** are stored — never bank credentials.

## Lifecycle

```
DRAFT → PENDING_CONFIGURATION → PENDING_VERIFICATION → TESTING → READY_FOR_LIVE → ACTIVE
                                                                     ↘ SUSPENDED / REJECTED
```

## Steps

1. **Create** the merchant (env, country, legal name, display name, settlement
   currency, provider, mode).
2. **Configure** (editable in DRAFT/PENDING_CONFIGURATION): account identifier,
   `secretKeyRef`, `webhookSecretRef`, public key, payout destination reference.
3. **Accept terms**.
4. **Set webhook status** to CONFIGURED/VERIFIED once the provider webhook is wired.
5. **Advance** through the states. Requesting verification requires business +
   provider + account + secret references complete.
6. **Set verification** VERIFIED after the provider approves the merchant.
7. **Test connection** — health-checks the merchant's OWN credentials.
8. **Certify** — run [sandbox certification](./SANDBOX-CERTIFICATION.md).
9. **Activate** at READY_FOR_LIVE — requires every blocking checklist item; creates
   a runtime `MerchantAccount` under the env's provider config.

## Activation checklist (blocking)

Business details, provider selected, account identifier, valid secret references,
webhook configured, merchant verified, terms accepted. (Payout destination is
advisory.)

## Suspend / reject

- **Suspend** deactivates the linked `MerchantAccount` (stops settlement to it).
- **Reject** ends the workflow.

Every action is audited.
