# Production Activation Guide

The sequence to safely accept the first real customer payment for a provider in
PRODUCTION (ADR-028). Nothing goes live until every control is green.

## Preconditions (in order)

1. **Secret manager**: `SECRET_MANAGER_PROVIDER` is a cloud backend (not `env`) and
   healthy. Live secrets stored (see [Secret Manager](./SECRET-MANAGER-INTEGRATION.md)).
2. **Config promoted** to PRODUCTION (disabled) via
   [Environment Promotion](./ENVIRONMENT-PROMOTION.md).
3. **Provider config**: mode LIVE, non-placeholder public key + secret/webhook refs.
4. **Merchant** onboarded + ACTIVE with webhook VERIFIED
   ([Merchant Onboarding](./MERCHANT-ONBOARDING.md)).
5. **Certification**: a recent PASS ([Sandbox Certification](./SANDBOX-CERTIFICATION.md)).
6. **Route**: a PaymentRoute exists for the provider/currency in PRODUCTION.

## Activate

1. Set the master switch: `PAYMENT_LIVE_ENABLED=true` (and `APP_ENV=PRODUCTION`).
2. Enable the provider config in the admin console (Payment Config). The fail-closed
   validator must show green.
3. Confirm readiness:
   ```
   GET /admin/payments/live-readiness?provider=<name>
   ```
   Every global + per-provider check must pass (**GO**). Checks: live-enabled, env
   PRODUCTION, secret manager healthy, maintenance off, mode LIVE, not dummy,
   credentials valid, provider health, ACTIVE merchant, webhook verified, recent
   certification, route matches, circuit not open.
4. Verify with a small real transaction; watch metrics + reconciliation.

## Roll back

Disable the provider config (or activate maintenance mode); the readiness gate flips
to **NO-GO** and no new live intents route to it.

The readiness report never exposes secrets — booleans + safe detail only.
