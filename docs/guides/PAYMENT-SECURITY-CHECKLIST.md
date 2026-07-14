# Payment Security Checklist

Operational checklist for going (and staying) live. See the full review in
[PAYMENT-SECURITY-SIGNOFF.md](../reports/PAYMENT-SECURITY-SIGNOFF.md).

## Secrets

- [ ] `SECRET_MANAGER_PROVIDER` is a cloud backend in UAT/STAGING/PRODUCTION (never `env`).
- [ ] Live secrets stored as references; no raw secret in env files or config.
- [ ] Managed identity / IAM role grants **read-only** access to payment secrets.
- [ ] `SECRET_CACHE_TTL_MS` set to a sane rotation window.

## Credentials

- [ ] Every enabled real provider is mode LIVE with non-placeholder credentials.
- [ ] No test keys in production; no live keys in lower envs.
- [ ] Rotation runbook rehearsed ([Credential Rotation](./CREDENTIAL-ROTATION-RUNBOOK.md)).

## Access control

- [ ] All `admin/payments/*` routes are ADMIN/SUPER_ADMIN only (RolesGuard).
- [ ] Two-person approval enforced for PRODUCTION promotions.
- [ ] `PAYMENT_LIVE_ENABLED` remains a deliberate switch.

## Webhooks

- [ ] Each provider's webhook is registered to `/api/payments/webhook/:provider`.
- [ ] Signatures verified per provider; settlement only from verified webhooks.
- [ ] Replay is safe (idempotent confirm).

## Observability & audit

- [ ] Metrics scraped (`etg_payment_*`); alerts on failover + circuit-open.
- [ ] Audit log shipped/retained; every config/onboarding/promotion/outage change present.
- [ ] Reconciliation daily job running; aging watched.

## Data handling

- [ ] No raw card/PAN/CVV/UPI-PIN/wallet/bank credentials stored anywhere.
- [ ] Provider/SDK error messages never returned to clients (generic 500).
- [ ] Money as integer minor units end to end; immutable fee snapshots on bookings.

## Go-live

- [ ] Recent PASS certification per merchant/provider.
- [ ] `GET /admin/payments/live-readiness` = GO for each launch provider/country.
- [ ] Outage runbook + rollback path known ([Provider Outage](./PROVIDER-OUTAGE-RUNBOOK.md)).
