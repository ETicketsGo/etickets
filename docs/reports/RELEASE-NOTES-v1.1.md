# ETicketsGo v1.1 — Release Notes (Commercial-Launch Increment)

**Date:** 2026-07-14 · **Line:** `feat/eticketsgo-platform` (mainline) ·
**Tag:** to be cut as **`v1.1.0`**

v1.0.0 was the **feature-complete** tag (the Experience Commerce Platform — events
and movies — as an atomic, oversell-proof booking engine; see
[RELEASE-NOTES-v1.0.md](./RELEASE-NOTES-v1.0.md)). **v1.1 is the commercial-launch
increment**: everything the twelve launch phases added to make v1.0 _deployable,
observable, supportable, and takeable-to-real-money_ — with **no change to the core
booking/money/inventory business logic**.

---

## What the 12 launch phases added on top of v1.0

### Real provider adapters (config-gated; safe defaults unchanged)

- **Payments** — real `stripe` and `razorpay` providers behind the existing
  `PaymentProviderInterface` (`apps/api/src/payments/provider/`), selected by
  `PAYMENT_PROVIDER_NAME`; `mock` stays the dev default and is force-disabled by
  `NODE_ENV=production` / `PAYMENTS_MOCK_ENABLED=false`. See
  [Payment Integration Guide](../guides/PAYMENT-INTEGRATION.md).
- **Notifications** — real transports per channel (`sendgrid`/`ses` email, `twilio`
  SMS, WhatsApp Cloud, `fcm` push), each `log` by default and **fail-fast at boot**
  if selected without keys. Email + in-app are wired end-to-end. See
  [Notification Integration Guide](../guides/NOTIFICATION-INTEGRATION.md).

### Cloud infrastructure-as-code + CI/CD

- Multi-stage, non-root Dockerfiles for all five deployables; `docker-compose.prod.yml`
  (db + redis + migrate one-shot + api + worker + 3 web) with health-gated boot
  order and a never-seed-prod policy; `.github/workflows/deploy.yml` (gate → build+push
  to GHCR by SHA → migrate → deploy → smoke). See
  [Deployment Guide](../guides/DEPLOYMENT.md).

### Observability stack

- `prom-client` `etg_*` metrics on API (`/api/metrics`) and worker (`:4100/metrics`),
  structured JSON logs + correlation IDs, slow-query reporting, opt-in Sentry and
  OpenTelemetry, and a Prometheus + Grafana stack with dashboards and alert rules
  (`docker-compose.observability.yml`, `observability/prometheus/alerts.yml`). See
  [Monitoring Guide](../guides/MONITORING.md) + [Monitoring Checklist](./MONITORING-CHECKLIST.md).

### Ops console & business reports

- Admin **ops console** (`/admin/ops`, `apps/api/src/ops`) with **maintenance mode**
  and queue/system health; **business reports** (`apps/api/src/analytics/business-reports.*`).
  See [Operations](./OPERATIONS.md).

### Organizer onboarding, customer success & support

- Organizer/admin onboarding guides and the support surface in the product:
  in-app **feedback widget** + **support inbox** (`/admin/support`, kinds
  `CONTACT`/`BUG`/`FEATURE`/`GENERAL`/`CSAT`/`ORGANIZER_CSAT`) + CSAT surveys, with a
  production [Support Plan](./SUPPORT-PLAN.md), [Escalation Matrix](../pilot/ESCALATION-MATRIX.md),
  and [Incident Response](../pilot/INCIDENT-RESPONSE.md).

### Security validation + Next.js CRITICAL fix

- Pentest-style review + OWASP Top 10 + per-advisory dependency triage; **no open
  Critical/High code issue**. The **Next.js CRITICAL is fixed** (`next@14.2.35`).
  See [Security Validation](./SECURITY-VALIDATION.md).

### Performance & capacity validation

- Live single-node measurements of the seat-hold/GA contention paths and cached
  reads, plus a capacity envelope and the binding-resource analysis. See
  [Performance Validation](./PERFORMANCE-VALIDATION.md) + [Capacity Report](./CAPACITY-REPORT.md).

### Go-live documentation set

- [Production Architecture](./PRODUCTION-ARCHITECTURE.md) (with Mermaid infra +
  runtime diagrams), [Known Limitations](./KNOWN-LIMITATIONS.md),
  [Top 20 Risks](./TOP-20-RISKS.md), [90-Day Roadmap](./ROADMAP-90-DAY.md),
  [Rollback Plan](./ROLLBACK-PLAN.md), [Disaster Recovery](./DISASTER-RECOVERY.md),
  and the [Deliverables Index](./DELIVERABLES-INDEX.md). Pilot docs under `docs/pilot/`.

---

## Verification (this increment)

- **Typecheck** 16/16 tasks · **Lint** clean · **Prettier** clean.
- **Unit tests** 323/323 (48 suites) · **Circular deps** none (`madge`) · **Build** 8/8.
- **Playwright e2e** 4/4 — GA booking, movie seat booking, organizer wizard, admin review.
- **Prod dependency audit** (`npm audit --omit=dev`) = **0 critical / 8 high** — all
  transitive & not exploitable in-app ([Security Validation §2](./SECURITY-VALIDATION.md)).
- **Live concurrency harness PASSED** — 25 concurrent same-seat → exactly 1 wins;
  GA 49 wins == stock, **0 oversell**.

---

## Known limitations & upgrade notes

- Providers are mock/log by **default** — production must set real payment +
  notification keys; SMS/WhatsApp/push still need recipient plumbing.
- No tax/GST modelling; AI recommendation is a no-op port; collaborative filtering
  is a stub; enterprise modules (CRM/Sponsors/Templates/Memberships/White-label) are
  flag-gated foundations; no offline check-in; blob storage not wired; tokens in
  `localStorage` (D6); no API versioning (D12); 8 transitive High advisories pending
  a `@nestjs`/Next 15 major.
- **Release hygiene (do first):** commit the `next ^14.2.35` bump **with** its
  reconciled `package-lock.json` so `npm ci` deploys `14.2.35`, not the vulnerable
  `14.2.15` (V7/D21).

Full detail: [Known Limitations](./KNOWN-LIMITATIONS.md) ·
[Tech Debt Register](./TECH-DEBT-REGISTER.md) ·
[Launch Readiness](./LAUNCH-READINESS.md) (score + go/no-go, finalised by the CTO
office).
