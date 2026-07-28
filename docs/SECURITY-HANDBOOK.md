# SECURITY-HANDBOOK (P6.12)

Operational security reference. Full audits: `docs/p6/P6.5-INFRASTRUCTURE-SECURITY-REVIEW.md`,
`docs/reports/DEPENDENCY-REMEDIATION.md`.

## Controls in place

- **Edge:** helmet security headers, CORS allowlist (never `*`), `trust proxy` for real-client rate
  limiting, TLS/HSTS at the LB, Swagger off in production.
- **AuthN/Z:** JWT (15-min access, 30-day refresh, secrets via `getOrThrow`); RBAC on admin;
  tenant isolation on every admin query/mutation (cross-tenant → 404).
- **Money integrity:** provider/amount/currency server-derived; client cannot select provider, set
  amount, or set compensation type; refunds fail-closed (`MANUAL_ONLY`).
- **Webhooks:** signature-verified + idempotent (duplicate callbacks deduped).
- **Data:** parameterized SQL only; Redis keys env-namespaced + no secrets/PII; telemetry PII-free.
- **CI:** security.yml runs npm audit + dependency-review (fail-on-high for new deps) + TruffleHog +
  migration-drift on every PR.

## Secret management

All secrets in the platform secret store (never committed). Rotate on suspected compromise;
rotating `QR_SIGNING_SECRET` invalidates issued QR (coordinate). Payment live keys only in the prod
account/env.

## Open security gates (pre-production)

- **SEC-1:** remediate runtime dependency highs (Batch A in DEPENDENCY-REMEDIATION.md).
- Body/upload limits + Prisma pool sizing + web-app CSP (P6.5 recommendations).
- Run the staging attack matrix (cross-user/tenant, provider spoof, price/currency tamper, webhook
  replay/sig-fail, idempotency abuse, refund-amount/comp-type tamper, privilege escalation).

## Incident response (security)

Contain (rotate secrets / flip kill switches) → assess blast radius → eradicate → recover → review.
Money/PII incidents are severity=page. See ONCALL-RUNBOOK.md + DISASTER-RECOVERY.md.
