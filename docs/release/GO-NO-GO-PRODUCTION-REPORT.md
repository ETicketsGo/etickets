# ETicketsGo — Go / No-Go Production Report

The final launch-decision document for the commercial (public) launch. Each area carries a status:
**GO** (ready), **CONDITIONAL** (ready once an operator action is done — credentials, sign-off,
provisioning), or **NO-GO** (blocker). This report certifies the _software_; the CONDITIONAL items are
deployment/business actions the launch team must complete and record.

**Overall verdict: GO — conditional on the CONDITIONAL items below being completed and signed off.**
The platform is engineering-complete and audited (v2.1); the remaining items are operational
(credentials, provisioning, legal counsel, live-payment certification), not code.

## Decision matrix

| #   | Area                         | Status      | Evidence / action                                                                                                                                                                                                                                                                          |
| --- | ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Production configuration** | CONDITIONAL | Set real ≥24-char secrets + `CORS_ORIGINS`; the boot gate enforces this. Verify via the [Production Verification Checklist](PRODUCTION-VERIFICATION-CHECKLIST.md).                                                                                                                         |
| 2   | **Legal documents**          | CONDITIONAL | Terms, Privacy, Refund, Organizer Agreement drafts exist under `docs/commercial/` — **require counsel review + jurisdiction (India) sign-off** before public launch. Marked as drafts today.                                                                                               |
| 3   | **Pricing**                  | CONDITIONAL | Platform fee model + tiers documented ([PLATFORM-FEES](../commercial/PLATFORM-FEES.md)); confirm the live fee tiers (`FeeRule`) and currency (INR) match the commercial agreement before enabling live payments.                                                                           |
| 4   | **Payments**                 | CONDITIONAL | Runtime multi-provider + circuit breaker + failover are built and tested; **live requires per-provider sandbox certification + `PAYMENT_LIVE_ENABLED=true` + real credentials via secret refs**. Until then, mock.                                                                         |
| 5   | **SEO**                      | GO          | Marketing site has metadata (title templates, OG/Twitter/canonical), `sitemap.ts`, `robots.ts`, semantic headings; legal/draft pages `noindex`. Verify canonical host after DNS.                                                                                                           |
| 6   | **Analytics**                | CONDITIONAL | Product analytics (funnel, GMV, payment health, growth) exist in Admin/Reports; wire an external web-analytics/consent tag if required by the marketing plan.                                                                                                                              |
| 7   | **Monitoring**               | CONDITIONAL | `/metrics`, health/readiness (503-aware), Sentry/OTel hooks are in place; **arm dashboards + alerts** (readiness flap, payment-failure spike, queue-failed, resource saturation) per [OPERATIONS-CHECKLIST](OPERATIONS-CHECKLIST.md).                                                      |
| 8   | **Security**                 | GO          | v2.1 audit: no Critical/High; global JWT+roles guard, tenant isolation asserted on every mutation, Zod validation, rate limits (auth/AI/global), production hardening gate, no card data stored (SAQ-A posture). See [PRODUCTION-CERTIFICATION-v2.1](PRODUCTION-CERTIFICATION-v2.1.md) §4. |
| 9   | **Accessibility**            | GO          | Broadly WCAG 2.1 AA; v2.1 fixed the outstanding input-label gaps; keyboard, focus management, contrast, screen-reader labels verified. Certification §7.                                                                                                                                   |
| 10  | **Performance**              | GO          | `next/font`, code-splitting, lazy images, bounded queries + v2.1 scalability indexes. Certification §6. Follow-up (`next/image`) documented, non-blocking.                                                                                                                                 |
| 11  | **Reliability / DR**         | CONDITIONAL | Circuit breaker, Redis fail-open, retryable workers, backups; **rehearse the DR restore and record RPO/RTO** ([runbook](PRODUCTION-DEPLOYMENT-RUNBOOK.md) §9) before launch.                                                                                                               |
| 12  | **Scale readiness**          | CONDITIONAL | Single-instance is ready; **deploy a Redis-backed shared throttler before running >1 API instance** ([KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md)).                                                                                                                                           |

## Quality gate (software, at time of certification)

typecheck 13/13 · lint 3/3 · madge 0 cycles · web-kit vitest 123/123 · API jest 634/634 (89 suites) ·
build 8/8 · e2e flag-off 10 passed / 13 skipped · offline 404 (flag-off) · readiness 200-healthy /
503-degraded · pilot fixture OK.

## Capability posture at launch (recommended)

Per the [Capability Inventory](../ops/CAPABILITY-INVENTORY.md): keep AI, web/native push, offline
check-in, and wallet passes **disabled** until their credentials are configured and verified; enable
live payments only after certification. Everything else (ticketing, commerce, discovery, organizer +
admin platforms, PWA, notifications inbox) is on by default and launch-ready.

## Launch checklist (execute in order)

1. Provision infra + managed Postgres/Redis + object storage + CDN; set DNS + TLS for all four hosts.
2. Populate `.env.production`; confirm the boot gate passes; capability posture set.
3. `prisma migrate deploy`; verify v2.1 indexes; do **not** seed.
4. Complete legal sign-off (item 2) and confirm live pricing (item 3).
5. Certify + enable the live payment provider (item 4); verify webhook reconciliation.
6. Arm monitoring dashboards + alerts (item 7); confirm health/readiness probes wired.
7. Rehearse DR restore; record RPO/RTO (item 11). Deploy shared throttler if scaling out (item 12).
8. Run the [Production Verification Checklist](PRODUCTION-VERIFICATION-CHECKLIST.md) — all pass.
9. Smoke the golden path with a real paid booking; confirm ticket + audit + payout path.
10. Announce; monitor closely for 48h ([LAUNCH-COMMUNICATIONS](../launch/LAUNCH-COMMUNICATIONS.md)).

## Rollback checklist (if launch goes wrong)

Follow [ROLLBACK-CHECKLIST](ROLLBACK-CHECKLIST.md): redeploy the previous image tag (additive
migrations keep it compatible); if payment issues, flip `PAYMENT_LIVE_ENABLED=false` (or the maintenance
flag) to stop live charges; communicate per [INCIDENT-RESPONSE](../launch/INCIDENT-RESPONSE.md);
never hand-drop a migrated column — forward-fix only.

## Sign-off

| Role               | Name | GO / NO-GO | Date |
| ------------------ | ---- | ---------- | ---- |
| Engineering        |      |            |      |
| Product            |      |            |      |
| Legal / Compliance |      |            |      |
| Operations         |      |            |      |

**Recommendation:** GO for public launch once items 1–7 are completed, verified against the checklist,
and signed off above.
