# Azure Key Vault Setup Guide

Use Azure Key Vault as the payment secret backend (`SECRET_MANAGER_PROVIDER=azure`).

## Prerequisites

- An Azure Key Vault (e.g. `etg-payments-prod`).
- The API/worker running with a **managed identity** (or workload identity in AKS).
- SDKs installed in the API/worker image:
  ```bash
  npm i @azure/keyvault-secrets @azure/identity
  ```

## Configure

```bash
SECRET_MANAGER_PROVIDER=azure
AZURE_KEY_VAULT_URL=https://etg-payments-prod.vault.azure.net
```

Authentication uses `DefaultAzureCredential` (managed identity → env → CLI). No
secret is placed in configuration.

## Grant access

Give the identity **Get** on secrets (RBAC role `Key Vault Secrets User`, or an
access policy with `get`).

## Store secrets

Secret names map from references by replacing `/` with `-`:

| Reference                                   | Key Vault secret name                       |
| ------------------------------------------- | ------------------------------------------- |
| `payments/stripe/production/secret-key`     | `payments-stripe-production-secret-key`     |
| `payments/stripe/production/webhook-secret` | `payments-stripe-production-webhook-secret` |

```bash
az keyvault secret set --vault-name etg-payments-prod \
  --name payments-stripe-production-secret-key --value "sk_live_..."
```

## Verify

- `GET /admin/payments/health` → secret manager healthy.
- `GET /admin/payments/live-readiness` → per-provider credentials resolve.
- Rotate: update the secret, then `PaymentProviderFactory.refresh` (see
  [Credential Rotation](./CREDENTIAL-ROTATION-RUNBOOK.md)).
