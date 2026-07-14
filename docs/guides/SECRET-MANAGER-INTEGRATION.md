# Secret Manager Integration Guide

The payment platform resolves secret **references** (never raw values) into secret
values at runtime through the `SecretManager` abstraction (ADR-024). Select the
backend with `SECRET_MANAGER_PROVIDER`.

## Backends

| `SECRET_MANAGER_PROVIDER` | Backend                       | Allowed environments                                         |
| ------------------------- | ----------------------------- | ------------------------------------------------------------ |
| `env` (default)           | Process environment variables | LOCAL, DEV, QA only — **rejected** in UAT/STAGING/PRODUCTION |
| `azure`                   | Azure Key Vault               | any (see [Azure setup](./AZURE-KEY-VAULT-SETUP.md))          |
| `aws`                     | AWS Secrets Manager           | any (see [AWS setup](./AWS-SECRETS-MANAGER-SETUP.md))        |
| `gcp`                     | GCP Secret Manager            | any                                                          |

Cloud backends are **feature-gated**: their SDK is loaded lazily and only required
when selected. Install the SDK in that environment's image.

## Reference format

`namespace/segment/.../key` — lowercase, hyphen-separated segments, 2–8 deep, e.g.:

```
payments/stripe/production/secret-key
payments/stripe/production/webhook-secret
payments/razorpay/production/secret-key
```

Backend key derivation:

- **env** → `PAYMENTS_STRIPE_PRODUCTION_SECRET_KEY` (uppercased, `/` and `-` → `_`)
- **Azure** → `payments-stripe-production-secret-key` (`/` → `-`)
- **AWS** → the reference used verbatim as the SecretId
- **GCP** → `payments_stripe_production_secret_key`, latest version

## Configuration

```bash
SECRET_MANAGER_PROVIDER=aws            # env | azure | aws | gcp
SECRET_CACHE_TTL_MS=300000             # resolved-secret cache TTL (rotation window)
# backend-specific:
AZURE_KEY_VAULT_URL=https://<vault>.vault.azure.net
AWS_SECRETS_REGION=us-east-1
GCP_PROJECT_ID=my-project
```

## Guarantees

- Secret **values** are never logged and never returned in errors (`maskSecret`,
  `redactSecrets`, `SecretResolutionError` carries only the reference + a safe reason).
- Missing required secrets **fail closed**.
- Short TTL cache; `invalidateCache` on config change; `PaymentProviderFactory.refresh`
  after rotation (see [Credential Rotation](./CREDENTIAL-ROTATION-RUNBOOK.md)).
- **Health/readiness**: `GET /admin/payments/health` and `/admin/payments/live-readiness`
  report secret-manager health without exposing secrets.
