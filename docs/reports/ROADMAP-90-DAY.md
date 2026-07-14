# ETicketsGo — First 90-Day Roadmap (v1.1 → v1.x)

> **Recommendations, not commitments.** A prioritized plan for the first 90 days
> after the commercial launch, synthesised from the
> [Tech Debt Register](./TECH-DEBT-REGISTER.md), the
> [Known Limitations](./KNOWN-LIMITATIONS.md), the
> [Security Validation §7](./SECURITY-VALIDATION.md), the
> [Capacity Report](./CAPACITY-REPORT.md), and the pilot feedback loop
> ([Pilot Guide](../pilot/PILOT-GUIDE.md)). Sequencing favours **de-risking real
> money + comms first**, then **hardening security/testing/observability**, then
> **product depth**. The CTO office finalises scope.

Register IDs (`D#`) and validation IDs (`V#`) are cross-referenced so each item is
traceable to its source finding.

---

## 0–30 days — "Take real money safely" (v1.1.x)

The gap between a controlled launch and general availability is real
provider + backups + alerting ([LAUNCH-READINESS conditions](./LAUNCH-READINESS.md)).
Close it first.

| Item                                                              | Why now                                                                                                                                                                      | Refs                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Wire a real payment provider to production + reconciliation**   | Bind Stripe/Razorpay behind the existing interface, `PAYMENTS_MOCK_ENABLED=false`, register the webhook, and add a provider-vs-ledger reconciliation routine. The #1 GA gap. | [Payment Guide](../guides/PAYMENT-INTEGRATION.md), [Known Limitations §1](./KNOWN-LIMITATIONS.md) |
| **Commit the Next.js bump + reconciled lockfile together**        | At `HEAD` the lock still pins `next@14.2.15` (CRITICAL); `npm ci` would deploy it. Land the `14.2.35` bump + lock in one commit. Quick, high value.                          | V7 / D21                                                                                          |
| **Provision managed Postgres (PITR) + Redis; stand up alerting**  | Enable WAL/PITR backups (RPO ≤ 5 min), wire `observability/prometheus/alerts.yml` → Alertmanager → Slack/PagerDuty.                                                          | [DR](./DISASTER-RECOVERY.md), [Monitoring Checklist](./MONITORING-CHECKLIST.md)                   |
| **`trust proxy` + tighten `/metrics` / Swagger exposure**         | Set proxy trust so auth throttling keys on the real client IP; network-restrict `/metrics`; gate Swagger out of prod.                                                        | D7 / V2, V4/D18                                                                                   |
| **Real email delivery end-to-end**                                | Set `EMAIL_PROVIDER=sendgrid`/`ses` + `EMAIL_FROM`; verify booking/refund emails deliver (email is already wired).                                                           | [Notification Guide](../guides/NOTIFICATION-INTEGRATION.md)                                       |
| **Fill escalation roster + on-call rotation; test alert routing** | The [Escalation Matrix](../pilot/ESCALATION-MATRIX.md) placeholders must be populated before the doors open.                                                                 | [Support Plan](./SUPPORT-PLAN.md)                                                                 |

**Exit criteria:** real charges + refunds reconcile; PITR verified by a restore
drill; alerts page a human; smoke green on prod.

---

## 30–60 days — "Harden security, testing, and comms breadth" (v1.2)

With money live, close the highest-value security and quality debt.

| Item                                                             | Why now                                                                                                                                                                                             | Refs                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Token storage → `HttpOnly` cookie + CSRF**                     | Eliminate the XSS→persistent-ATO risk: refresh token in `HttpOnly`+`Secure`+`SameSite` cookie, access token in memory. **Highest-priority security item.**                                          | D6 / V1                                        |
| **API versioning (`/api/v1`)**                                   | `enableVersioning({type:URI})` before the surface grows — cheaper now than later.                                                                                                                   | D12                                            |
| **DB-backed integration + concurrency suite in CI**              | The atomic holds are proven by a live harness but not a CI test; add an integration project against CI Postgres firing N concurrent reserves → exactly one wins. **Highest-value test investment.** | D13                                            |
| **Recipient plumbing for SMS/WhatsApp/push + delivery webhooks** | Persist phone numbers / device tokens + opt-in, then enable Twilio/WhatsApp Cloud/FCM transports and ingest delivery/status webhooks.                                                               | [Known Limitations §1](./KNOWN-LIMITATIONS.md) |
| **E2E coverage: refund + check-in + seat-map authoring**         | Close the Playwright gaps; seed a deterministic pending event; remove conditional assertions.                                                                                                       | D14                                            |
| **Refresh-token reuse hardening + QR validity window**           | Revoke the descendant chain on replay; enforce a QR validity window + rotate nonce/version on reversal.                                                                                             | D5, D15 / V6                                   |

**Exit criteria:** no tokens in `localStorage`; `/api/v1` live; CI proves
concurrency; at least one non-email channel delivering with status tracking.

---

## 60–90 days — "Clear transitive Highs + product depth" (v1.3)

Bigger, maintenance-window work and the first commercial capability slices.

| Item                                                     | Why now                                                                                                                                  | Refs                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **`@nestjs/*` major upgrade** (maintenance window)       | Clears the `multer`/`body-parser`/`qs`/`platform-express` HIGH cluster (not exploitable today, but clears the audit).                    | D20, [Sec Validation §2](./SECURITY-VALIDATION.md) |
| **Next.js 15 major upgrade**                             | Clears the residual `next`/`@next/*`/`eslint-config-next` HIGHs (no clean 14.x patch). Validate the Tailwind-preset gotcha post-upgrade. | D20                                                |
| **Blob storage for assets/posters/exports**              | Point `STORAGE_DRIVER=s3` + `S3_*` at a bucket for durable uploads/exports (currently ephemeral `local`).                                | [Known Limitations §5](./KNOWN-LIMITATIONS.md)     |
| **Tax / GST modelling**                                  | Add a tax component + invoice breakdown before markets that require itemised tax.                                                        | [Known Limitations §2](./KNOWN-LIMITATIONS.md)     |
| **Organizer CRM first slice (behind flag)**              | Ship a real slice of `organizerCrm` (ADR-015) behind its flag — the highest-demand enterprise foundation.                                | [Known Limitations §4](./KNOWN-LIMITATIONS.md)     |
| **Payout settled-cursor (schema change)**                | Add `Payout ↔ Booking` settlement linkage so each booking's revenue is paid once across cycles.                                          | D1                                                 |
| **Real Grafana/alerting maturity + capacity re-measure** | Move from "provisioned" to tuned dashboards/SLOs; run a distributed k6 load test against prod-class hardware to certify capacity.        | [Capacity Report §4–5](./CAPACITY-REPORT.md)       |
| **Offline check-in (spike → build)**                     | Local scan queue for gate devices that lose connectivity — a real pilot pain point.                                                      | [Known Limitations §5](./KNOWN-LIMITATIONS.md)     |

**Exit criteria:** `npm audit --omit=dev` shows 0 high; durable asset storage;
first CRM slice usable behind its flag; a certified capacity number.

---

## Cross-cutting throughout

- **Pilot feedback loop** — triage `/admin/support` (CSAT/BUG/FEATURE) weekly;
  reprioritise this roadmap from real signal ([Support Plan §5](./SUPPORT-PLAN.md)).
- **Keep migrations additive** — preserves safe rollback throughout
  ([Rollback Plan](./ROLLBACK-PLAN.md)).
- **Quick wins any time** — `picomatch@4.0.5` bump (D20), constant-time missing-user
  login path (V3), movie `trailerUrl` surfacing (D17), seat a11y (D16).

> Effort/severity for every `D#` item: [Tech Debt Register](./TECH-DEBT-REGISTER.md).
> All dates/scoping are recommendations for the CTO office to finalise.
