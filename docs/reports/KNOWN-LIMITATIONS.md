# ETicketsGo — Known Limitations (v1.1)

> An honest inventory of what v1.1 does **not** do, or does only partially. None of
> these are launch-blocking for a **controlled / soft launch** (see
> [LAUNCH-READINESS](./LAUNCH-READINESS.md)); they set expectations and feed the
> [90-Day Roadmap](./ROADMAP-90-DAY.md). Each item cross-links its register entry —
> the prioritized backlog with efforts lives in the
> [Tech Debt Register](./TECH-DEBT-REGISTER.md) and the
> [Security Validation §7](./SECURITY-VALIDATION.md).

Everything below is **by design and config-gated** — the platform runs correctly on
its safe defaults; production simply needs the noted keys/plumbing turned on.

---

## 1. Providers are mock / log by default

- **Payments** ship `mock`, `stripe`, and `razorpay` adapters behind
  `PaymentProviderInterface`. Out of the box `PAYMENT_PROVIDER_NAME=mock` (dev). To
  take real money you must set a real provider + keys + `PAYMENT_WEBHOOK_SECRET` and
  `PAYMENTS_MOCK_ENABLED=false`, and register the webhook. See the
  [Payment Integration Guide](../guides/PAYMENT-INTEGRATION.md).
- **Notifications** default every channel to the `log` transport. **Email** and
  **in-app** are wired end-to-end. **SMS / WhatsApp / push** transports exist
  (Twilio / WhatsApp Cloud / FCM) but need **recipient plumbing** — persisted phone
  numbers / device tokens and per-user opt-in — before they deliver. Until then
  those channels are safely no-op `log`. See the
  [Notification Integration Guide](../guides/NOTIFICATION-INTEGRATION.md).

## 2. Money & tax modelling

- **No tax / GST modelling.** Prices are `priceMinor` + a fee calculator
  (`FeeRule`). There is no tax component, invoice tax breakdown, or jurisdictional
  tax logic. Fine for pilots that price tax-inclusive; needed before markets that
  require itemised tax. (Roadmap 60–90.)
- **Payout settled-cursor (D1).** Immediate double-payout vectors are guarded
  (atomic finalize + single open payout), but `settle()` re-sums all confirmed
  bookings with no per-booking settlement linkage across payout cycles. Structural
  correctness improvement gated behind a schema change. See
  [Tech Debt D1](./TECH-DEBT-REGISTER.md).

## 3. AI & recommendations

- **AI recommendation is a no-op port.** The `ai` module exposes extension
  **interfaces** with `Noop` default bindings — there is no model. The
  `aiRecommendations` flag is off. Recommendations today are the
  content/organizer/venue/trending strategies (ADR-022).
- **Collaborative filtering is a stub.** No behavioural co-occurrence data pipeline;
  "you might also like" is content/heuristic, not learned. (Register: collaborative
  filtering data.)

## 4. Enterprise modules are flag-gated foundations

The following are **placeholder architecture only**, disabled by default in
`FEATURE_DEFAULTS` and surfaced only behind their flag (never dead UI):
`organizerCrm`, `sponsors`, `eventTemplates`, `memberships` / `subscriptions`,
`whiteLabel`, `marketingAutomation`, `dynamicPricing`. Design rationale: ADR-015
(CRM), ADR-016 (community), ADR-017 (sponsors), ADR-019 (dynamic pricing). Turning
one on today exposes a foundation, not a finished product.

## 5. Operations gaps

- **No offline check-in.** Gate scanning requires connectivity to the API; a staff
  device offline fails scans until it reconnects (no local queue). See the
  [Check-in Guide](../pilot/CHECKIN-GUIDE.md).
- **Blob storage not wired.** The storage abstraction defaults to a `local`
  (ephemeral) driver; durable posters/exports need `STORAGE_DRIVER=s3` + `S3_*`.
  No object storage is provisioned yet. See [Deployment §1](../guides/DEPLOYMENT.md).
- **Production observability is provisioned-not-yet-live at rest.** The stack,
  metrics, and alert rules exist (`docker-compose.observability.yml`,
  `observability/prometheus/alerts.yml`); real Grafana/Alertmanager/on-call and
  managed-Postgres PITR are deploy-time tasks. See the
  [Monitoring Checklist](./MONITORING-CHECKLIST.md).

## 6. Security backlog (none launch-blocking; all triaged)

Verified in the [Security Validation](./SECURITY-VALIDATION.md) — no open
Critical/High **code** issue. Residual, registered items:

- **Tokens in `localStorage` (D6 / V1).** `etg_access` / `etg_refresh` in
  `localStorage` → any XSS becomes persistent account takeover. No XSS sink found in
  app code (no `dangerouslySetInnerHTML` / `eval`; React auto-escaping), so it is a
  **latent, not active** risk. Fix: refresh token → `HttpOnly`+`Secure`+`SameSite`
  cookie, access token in memory, add CSRF. **Highest-priority security item.**
- **No API versioning (D12).** Single `/api` prefix, no `/api/v1`. Adds friction to
  breaking-change management; not a defect.
- **`trust proxy` unset (D7 remainder / V2).** Auth throttling keys on the socket
  IP; behind a proxy, clients can share a throttle bucket. Deploy-time config.
- **Swagger UI ungated (D18 / V4)**, **QR tokens never expire (D15 / V6)**, **login
  timing oracle (D19 / V3)** — all Low, documented, rate-limiting blunts the
  enumeration path.

## 7. Dependency vulnerabilities (transitive, not exploitable)

`npm audit --omit=dev` = **0 critical / 8 high** (35 moderate). Every HIGH is
**transitive and triaged not exploitable in this app** — no file-upload surface
(`multer`/`@nestjs/platform-express`), `lodash` not imported, `glob`/`picomatch`
are CLI/build-time, and Next is already at the latest 14.x (the HIGHs need Next 15).
The prior **Next.js CRITICAL is fixed** (`14.2.35`). Clearing the Highs needs a
**`@nestjs/*` major** + **Next 15 major** upgrade in maintenance windows. Full
per-advisory triage: [Security Validation §2](./SECURITY-VALIDATION.md); register
entry [D20](./TECH-DEBT-REGISTER.md). Release hygiene note: commit the Next bump
with its reconciled lockfile together ([D21 / V7](./SECURITY-VALIDATION.md)).

## 8. Testing gaps

- **No real-DB concurrency test in CI (D13).** Unit tests mock the `tx` client; the
  atomic holds are verified by a **live concurrency harness** (25 same-seat → 1
  wins; 49 GA holds == stock, 0 oversell) but not yet a DB-backed CI integration
  project. **Highest-value test investment.**
- **E2E gaps (D14).** Refund, check-in, and seat-map authoring are not covered by
  Playwright; the admin spec has some conditional assertions. 4 journeys are green
  (GA booking, movie seat booking, organizer wizard, admin review).

---

_See the [Tech Debt Register](./TECH-DEBT-REGISTER.md) for severities/efforts and
the [90-Day Roadmap](./ROADMAP-90-DAY.md) for sequencing._
