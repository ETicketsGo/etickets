# ETicketsGo — Production Certification (v2.1 Enterprise Readiness Audit)

**Scope:** Engineering, security, scalability, reliability, performance, accessibility, UX, operations,
and documentation review of the full platform (v1.0 core → v2.0 AI & Growth), treating ETicketsGo as a
system for millions of customers. **No new product features** — only verified production improvements.

**Verdict: GO for production launch**, conditional on the operational checklist below (credentials +
shared throttler + DR rehearsal). The codebase is mature, consistently guarded, and well-tested; the
audit found no Critical or High security defects and a small set of genuine scalability/UX/ops gaps,
all fixed in this release.

---

## 1. Executive Summary

Four parallel read-only audits (DB/scalability, security/tenancy, performance/a11y/UX, docs/ops) plus a
reliability/ops review were run against the v1.2–v2.0 surface (the newest and least-hardened code). The
platform is architecturally sound and defensively coded: every org-scoped mutation asserts membership,
every admin route enforces roles, money is integer minor units with atomic oversell-proof holds, and AI
is disabled-by-default with deterministic fallbacks. Genuine fixes applied this release:

- **Scalability:** 5 indexes for the platform-wide risk-signal scans; a bounded (SQL `groupBy`) commerce
  report.
- **Security:** rate limiting on AI generation endpoints.
- **Reliability/Ops:** readiness probe returns 503 when degraded (deroutable).
- **UX/a11y/perf:** confirmation on destructive commerce deletes; input labels; lazy poster loading.
- **Docs:** README/architecture refresh + a consolidated capability/toggle inventory.

## 2. Architecture Assessment — Strong

Modular monolith, clean domain boundaries, 0 circular dependencies (`madge`). Pure domain logic lives in
`shared-types` and is unit-tested; the AI, payment, and notification layers all use the same
provider-neutral factory seam (env-keyed, safe default, fail-fast on misconfig). Commerce reused the
booking/fee/inventory engine rather than forking it. No measurable duplication warranting refactor.
**No action required.**

## 3. Scalability Assessment — Good (fixed)

Confirmed-healthy: atomic guarded-SQL inventory holds (tickets + add-ons), transactional booking with
rollback, bounded hold-expiry and notification-dispatch sweeps (`take: 500`), adequately-indexed commerce
and notification hot paths. **Fixed this release:** the v2.0 risk service scanned Booking / PaymentAttempt
/ TicketInvite / Refund platform-wide by an unindexed `createdAt` window (full scans at scale) — added
`@@index` on each (`Refund` promoted to `[status, createdAt]`); added `Notification[userId, channel,
createdAt]` for the inbox cursor; rewrote `organizerCommerceReport` from an unbounded `findMany` + JS
reduce to a bounded SQL `groupBy`. **Remaining watch items:** a single Redis-backed shared throttler is
required before horizontal scale (per-instance today); connection-pool sizing at high concurrency.

## 4. Security Assessment — Strong

Global guard chain `Maintenance → Throttler → JWT → Roles`. Every audited v1.2–v2.0 endpoint verified:
org mutations assert `assertMember`; by-id add-on/bundle mutations resolve `organizationId` from the row
(no cross-tenant path); admin routes carry `@Roles(ADMIN, SUPER_ADMIN)`; bodies validated with Zod; admin
risk + AI console mask identifiers and expose no prompts/secrets/payloads; notification/push actions are
user-scoped. **Fixed:** AI generation endpoints now throttled 20/min/client (provider-budget abuse).
**Accepted low risk:** web-push `subscribe` reassigns a browser endpoint to the current session — correct
shared-device behavior, requiring the victim's secret endpoint URL to abuse. No Critical/High findings.

## 5. Reliability Assessment — Strong

Payment circuit breaker + failover + resilient executor; Redis fail-open (`commandTimeout`,
`enableOfflineQueue:false`, swallowed connection errors); worker jobs are idempotent + retryable
(`attempts` 2–3) + bounded; audit and AI-usage writes are fire-and-forget/fail-safe (never break the
primary path); payment provider errors mapped to correct HTTP codes (RC1). **Fixed:** `/ready` now returns
503 when a dependency check fails so orchestrators/load balancers deroute the pod.

## 6. Performance Assessment — Good (fixed)

`next/font` (Inter, swap) across apps; `WalletPasses` and discovery home already `next/dynamic`; user-driven
pagination (no unbounded auto-render). **Fixed:** movie-grid posters now lazy-load + async-decode.
**Follow-up (documented, low risk):** migrate remote `<img>` to `next/image` with a domain allowlist for
WebP/AVIF + `srcset` on discovery grids — a real byte/LCP win, deferred to avoid config churn at audit time.

## 7. Accessibility Assessment — Strong (fixed)

Broadly WCAG 2.1 AA: bottom-nav (`aria-current`/labels/44px), Dialog focus-trap + restore + Escape,
StatusBadge never colour-only, `role="status"`/`aria-live` on async banners, labeled controls throughout.
**Fixed:** the AI assistant "ask" input and event-review textarea gained `aria-label`s (placeholder is not
an accessible name).

## 8. UX Assessment — Strong (fixed)

Purchase/payment journeys are solid (loading states, decline handling, hold-timer recovery). **Fixed:**
destructive add-on/bundle deletes now require confirmation. **Follow-up (documented):** inline client
validation on the commerce create/edit form (currently server-toast only).

## 9. Operations Assessment — Ready

Liveness + readiness probes (readiness now deroutable), ops endpoints (queues/failed/maintenance/flags),
metrics + health + Sentry/OTel, production-hardening boot gate (rejects placeholder secrets/CORS in prod),
DR/rollback/deployment/operations checklists under `docs/release` and `docs/launch`. Added a consolidated
[Capability & Toggle Inventory](../ops/CAPABILITY-INVENTORY.md).

## 10. Documentation Assessment — Improved

**Fixed:** README status refreshed to reflect commerce/mobile/PWA/push/AI/movies; ARCHITECTURE module map
updated; new capability/toggle inventory. **Follow-up:** a dedicated commerce-ops runbook (add-on/bundle
inventory + revenue reconciliation) would round out the module guides.

## 11. Remaining Risks

| Risk                                                                                    | Severity  | Mitigation                                                                                   |
| --------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| Per-instance rate limiting; needs Redis-backed shared throttler before horizontal scale | Medium    | Documented; global + per-route throttles in place for single-instance                        |
| No booking-time IP/device signal → risk engine can't do IP/device velocity              | Low       | Uses email/user velocity, payment/refund/coupon/transfer signals; login IP on `RefreshToken` |
| Remote images not yet `next/image`-optimized on discovery grids                         | Low       | Lazy-load applied; full optimization is a follow-up                                          |
| Web-push endpoint reassignment on shared devices                                        | Low       | Correct behavior; requires secret endpoint to abuse                                          |
| Commerce create/edit lacks inline validation                                            | Low       | Server validation + toast; confirm dialogs on deletes                                        |
| AI provider not bundled → `generated` always false today                                | By design | Deterministic fallbacks are authoritative; no fake AI shipped                                |

## 12. External Dependencies

Postgres, Redis (fail-open). **Optional, unbundled, disabled by default:** payment gateways
(Stripe/Razorpay/PayPal/Square), FCM/VAPID push, Apple/Google wallet, email/SMS/WhatsApp providers, and
an AI provider (OpenAI/Anthropic). None are required to run the platform; each is a config/credential
drop-in behind an existing provider seam.

## 13. Recommended Launch Checklist

1. Set real core secrets (JWT access/refresh, QR/manifest signing, payment webhook) — ≥24 chars, no
   placeholders — and `CORS_ORIGINS`; the boot gate enforces this in prod.
2. Provision Postgres with the migrations applied; verify the new v2.1 indexes exist.
3. Deploy a **Redis-backed shared throttler** before running >1 API instance.
4. Configure payment provider + `PAYMENT_LIVE_ENABLED=true` only after sandbox certification per provider.
5. Decide each optional capability's posture via the [Capability Inventory](../ops/CAPABILITY-INVENTORY.md);
   leave AI/push/offline/wallet disabled until their credentials are verified.
6. Wire liveness `/health` + readiness `/ready` (503-aware) to the orchestrator; set alerts on
   queue-failed, payment-failure rate, and readiness flaps.
7. Rehearse rollback + DR (DB restore) per `docs/release`.

## 14. Long-term Technical Debt

- Shared (Redis) throttler + connection-pool tuning for horizontal scale.
- `next/image` migration + a CDN/image pipeline for discovery grids.
- Country/tax/i18n normalization for non-IN markets (documented in INTERNATIONAL-READINESS).
- A commerce-ops runbook; inline commerce form validation.
- Optional: real AI/web-push provider transports behind the existing seams.

## 15. Future Roadmap Suggestions

- Observability: per-tenant SLOs, cost dashboards (AI + payments), trace sampling.
- Data: read replicas + a reporting store for heavy analytics; archival of cold bookings.
- Growth: wire a real AI provider (the seam is ready) with the eval harness gating releases; collaborative
  filtering for recommendations once interaction data volume supports it.
