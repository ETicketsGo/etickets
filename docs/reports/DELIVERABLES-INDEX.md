# ETicketsGo — Go-Live Deliverables Index

> The master map for the commercial-launch program: each required **program
> deliverable** → the document(s) that satisfy it, and each **launch phase** → its
> artifacts. Use this as the entry point to the go-live documentation set.

---

## 1. The 12 required program deliverables

| #   | Deliverable                        | Satisfied by                                                                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Production Architecture**        | [PRODUCTION-ARCHITECTURE.md](./PRODUCTION-ARCHITECTURE.md) (+ [Architecture Handbook](../handbooks/ARCHITECTURE-HANDBOOK.md), [Context Map](../diagrams/CONTEXT-MAP.md)) |
| 2   | **Infrastructure Diagram**         | [PRODUCTION-ARCHITECTURE.md §4–5](./PRODUCTION-ARCHITECTURE.md) — Mermaid infrastructure + runtime/deployment diagrams                                                   |
| 3   | **Deployment Guide**               | [guides/DEPLOYMENT.md](../guides/DEPLOYMENT.md) (+ `docker-compose.prod.yml`, `.github/workflows/deploy.yml`)                                                            |
| 4   | **Payment Integration Guide**      | [guides/PAYMENT-INTEGRATION.md](../guides/PAYMENT-INTEGRATION.md)                                                                                                        |
| 5   | **Notification Integration Guide** | [guides/NOTIFICATION-INTEGRATION.md](../guides/NOTIFICATION-INTEGRATION.md)                                                                                              |
| 6   | **Monitoring Guide**               | [guides/MONITORING.md](../guides/MONITORING.md) + [MONITORING-CHECKLIST.md](./MONITORING-CHECKLIST.md)                                                                   |
| 7   | **Security Report**                | [SECURITY-VALIDATION.md](./SECURITY-VALIDATION.md) (+ [SECURITY-REPORT.md](./SECURITY-REPORT.md))                                                                        |
| 8   | **Performance Report**             | [PERFORMANCE-VALIDATION.md](./PERFORMANCE-VALIDATION.md) (+ [PERFORMANCE-REPORT.md](./PERFORMANCE-REPORT.md), [CAPACITY-REPORT.md](./CAPACITY-REPORT.md))                |
| 9   | **Launch Readiness Score**         | [LAUNCH-READINESS.md](./LAUNCH-READINESS.md) — **current score lives here** (finalised by the CTO office)                                                                |
| 10  | **Go / No-Go decision**            | [LAUNCH-READINESS.md](./LAUNCH-READINESS.md) — recommendation + conditions (finalised by the CTO office)                                                                 |
| 11  | **Top 20 Risks**                   | [TOP-20-RISKS.md](./TOP-20-RISKS.md)                                                                                                                                     |
| 12  | **First 90-Day Roadmap**           | [ROADMAP-90-DAY.md](./ROADMAP-90-DAY.md)                                                                                                                                 |

> **On deliverables 9 & 10:** the Launch Readiness Score and the Go/No-Go verdict
> are owned and finalised by the CTO office in
> [LAUNCH-READINESS.md](./LAUNCH-READINESS.md). This index only points to them.

---

## 2. Launch-phase → artifact map (12 phases)

The commercial-launch program ran in twelve phases on top of the feature-complete
v1.0. Each phase's artifacts:

| Phase | Theme                          | Primary artifacts                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Real payment adapters          | [PAYMENT-INTEGRATION.md](../guides/PAYMENT-INTEGRATION.md); `apps/api/src/payments/provider/{stripe,razorpay,mock}`                                                                                                                                                                                                                                                                                  |
| 2     | Real notification adapters     | [NOTIFICATION-INTEGRATION.md](../guides/NOTIFICATION-INTEGRATION.md); `apps/api/src/notifications`                                                                                                                                                                                                                                                                                                   |
| 3     | Cloud IaC + CI/CD              | [DEPLOYMENT.md](../guides/DEPLOYMENT.md); `docker-compose.prod.yml`, Dockerfiles, `.github/workflows/deploy.yml`                                                                                                                                                                                                                                                                                     |
| 4     | Observability stack            | [MONITORING.md](../guides/MONITORING.md) + [MONITORING-CHECKLIST.md](./MONITORING-CHECKLIST.md); `docker-compose.observability.yml`, `observability/prometheus/alerts.yml`                                                                                                                                                                                                                           |
| 5     | Scaling & capacity             | [SCALING-GUIDE.md](./SCALING-GUIDE.md), [SCALING-RECOMMENDATION.md](./SCALING-RECOMMENDATION.md), [CAPACITY-REPORT.md](./CAPACITY-REPORT.md)                                                                                                                                                                                                                                                         |
| 6     | Disaster recovery & ops        | [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md), [OPERATIONS.md](./OPERATIONS.md), [ROLLBACK-PLAN.md](./ROLLBACK-PLAN.md), [Runbooks](../handbooks/RUNBOOKS.md)                                                                                                                                                                                                                                       |
| 7     | Security validation            | [SECURITY-VALIDATION.md](./SECURITY-VALIDATION.md) (+ Next.js CRITICAL fix), [SECURITY-REPORT.md](./SECURITY-REPORT.md)                                                                                                                                                                                                                                                                              |
| 8     | Performance validation         | [PERFORMANCE-VALIDATION.md](./PERFORMANCE-VALIDATION.md), [PERFORMANCE-REPORT.md](./PERFORMANCE-REPORT.md)                                                                                                                                                                                                                                                                                           |
| 9     | Organizer onboarding           | [ORGANIZER-GUIDE.md](../pilot/ORGANIZER-GUIDE.md), [PILOT-GUIDE.md](../pilot/PILOT-GUIDE.md), [ADMIN-GUIDE.md](../pilot/ADMIN-GUIDE.md)                                                                                                                                                                                                                                                              |
| 10    | Customer success & support     | [SUPPORT-PLAN.md](./SUPPORT-PLAN.md), [SUPPORT-HANDBOOK.md](./SUPPORT-HANDBOOK.md), [SUPPORT-PLAYBOOK.md](../pilot/SUPPORT-PLAYBOOK.md), [ESCALATION-MATRIX.md](../pilot/ESCALATION-MATRIX.md), [INCIDENT-RESPONSE.md](../pilot/INCIDENT-RESPONSE.md), [CUSTOMER-GUIDE.md](../pilot/CUSTOMER-GUIDE.md), [CHECKIN-GUIDE.md](../pilot/CHECKIN-GUIDE.md)                                                |
| 11    | Ops console & business reports | [OPERATIONS.md](./OPERATIONS.md) (`/admin/ops`, maintenance mode); `apps/api/src/ops`, `apps/api/src/analytics/business-reports.*`                                                                                                                                                                                                                                                                   |
| 12    | Go-live: readiness & roadmap   | [PRODUCTION-ARCHITECTURE.md](./PRODUCTION-ARCHITECTURE.md), [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md), [TOP-20-RISKS.md](./TOP-20-RISKS.md), [ROADMAP-90-DAY.md](./ROADMAP-90-DAY.md), [RELEASE-NOTES-v1.1.md](./RELEASE-NOTES-v1.1.md), [LAUNCH-READINESS.md](./LAUNCH-READINESS.md), [GO-LIVE-CHECKLIST.md](./GO-LIVE-CHECKLIST.md), [LAUNCH-CHECKLIST.md](./LAUNCH-CHECKLIST.md), this index |

---

## 3. Final verification numbers (this program)

Measured on the mainline at go-live:

- **Typecheck** 16/16 tasks · **Lint** clean · **Prettier** clean.
- **Unit tests** 323/323 (48 suites) · **Circular deps** none (`madge`) · **Build** 8/8.
- **Playwright e2e** 4/4 (GA booking, movie seat booking, organizer wizard, admin review).
- **Prod dependency audit** (`npm audit --omit=dev`) = **0 critical / 8 high** (all
  transitive & not exploitable in-app — [SECURITY-VALIDATION §2](./SECURITY-VALIDATION.md)).
- **Live concurrency harness PASSED** — 25 concurrent same-seat → exactly 1 wins;
  GA 49 wins == stock, 0 oversell.

Documentation footprint: **15 ADRs** (`docs/adr/ADR-009..023`), **20 reports**
(`docs/reports/`), **4 integration/deployment guides** (`docs/guides/`), **3
handbooks** (`docs/handbooks/`), **2 diagram sets** (`docs/diagrams/`), **10 pilot
docs** (`docs/pilot/`).

---

## 4. Reading order

1. **Executives / go-no-go** → [LAUNCH-READINESS.md](./LAUNCH-READINESS.md) →
   [TOP-20-RISKS.md](./TOP-20-RISKS.md) → [ROADMAP-90-DAY.md](./ROADMAP-90-DAY.md).
2. **Architects** → [PRODUCTION-ARCHITECTURE.md](./PRODUCTION-ARCHITECTURE.md) →
   [Architecture Handbook](../handbooks/ARCHITECTURE-HANDBOOK.md) →
   [Context Map](../diagrams/CONTEXT-MAP.md).
3. **DevOps / SRE** → [DEPLOYMENT.md](../guides/DEPLOYMENT.md) →
   [MONITORING-CHECKLIST.md](./MONITORING-CHECKLIST.md) →
   [ROLLBACK-PLAN.md](./ROLLBACK-PLAN.md) → [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md).
4. **Support / success** → [SUPPORT-PLAN.md](./SUPPORT-PLAN.md) →
   [SUPPORT-PLAYBOOK.md](../pilot/SUPPORT-PLAYBOOK.md) →
   [ESCALATION-MATRIX.md](../pilot/ESCALATION-MATRIX.md).
5. **Integrators** → [PAYMENT-INTEGRATION.md](../guides/PAYMENT-INTEGRATION.md) →
   [NOTIFICATION-INTEGRATION.md](../guides/NOTIFICATION-INTEGRATION.md).
