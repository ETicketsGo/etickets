# AWS Secrets Manager Setup Guide

Use AWS Secrets Manager as the payment secret backend (`SECRET_MANAGER_PROVIDER=aws`).

## Prerequisites

- The API/worker running with an IAM role (task role / IRSA) — no static keys.
- SDK installed in the image:
  ```bash
  npm i @aws-sdk/client-secrets-manager
  ```

## Configure

```bash
SECRET_MANAGER_PROVIDER=aws
AWS_SECRETS_REGION=us-east-1
```

Credentials come from the default AWS provider chain (IAM role / env / profile).

## IAM policy

Grant `secretsmanager:GetSecretValue` on the payment secrets:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:payments/*"
}
```

## Store secrets

The reference is used verbatim as the `SecretId`:

```bash
aws secretsmanager create-secret \
  --name payments/stripe/production/secret-key \
  --secret-string "sk_live_..."
aws secretsmanager create-secret \
  --name payments/stripe/production/webhook-secret \
  --secret-string "whsec_..."
```

## Verify & rotate

- `GET /admin/payments/live-readiness` confirms resolution + health.
- On rotation, AWS updates the value; `SECRET_CACHE_TTL_MS` bounds propagation, or
  force it with `PaymentProviderFactory.refresh` (see
  [Credential Rotation](./CREDENTIAL-ROTATION-RUNBOOK.md)).
