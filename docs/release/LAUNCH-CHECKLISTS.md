# Launch Checklists (P6.11)

Consolidated go/no-go gates. The pilot-specific gate is `ETICKETSGO-PILOT-LAUNCH-CHECKLIST.md`; this
adds GO-LIVE, rollback, incident, support, and onboarding. Nothing launches with an open **blocker**.

## GO-LIVE checklist

- [ ] Staging soak (P6.4) green + load baseline (P6.5) captured; capacity ≥ launch cap with headroom.
- [ ] Chaos matrix (P6.6/6.8) passed on staging (fail-closed everywhere).
- [ ] Payment sandbox matrix green (P6.2); production keys configured in the prod secret store only.
- [ ] Migrations applied via release step; `migrate status` up-to-date; **migration-drift gate green**.
- [ ] Dashboards + alerts (P6.6) live; Alertmanager routed to on-call.
- [ ] Backup + PITR verified; **DR restore rehearsal passed** (P6.9/6.10).
- [ ] SEC-1 runtime dependency batch remediated (P6.4) or risk-accepted with sign-off.
- [ ] Feature flags at safe defaults; money automation OFF; `APP_ENV=PRODUCTION` set.
- [ ] TLS/HSTS at the edge; body limits + pool sizing applied (P6.5).
- [ ] Sign-off: Product · Finance · Engineering · SRE · Security.

## Rollback checklist

- [ ] Redeploy previous image tag (immutable; additive migrations keep it compatible).
- [ ] Flags → safe defaults: `BOOKING_ORCHESTRATOR_MODE=shadow`, provider-confirmation/allocated/
      compensation-exec/auto-void/auto-refund = false, `BOOKING_REFUND_POLICY_MODE=MANUAL_ONLY`.
- [ ] If a migration must be undone → author a forward revert migration (never hand-edit applied).
- [ ] Confirm `/api/ready` green + soak invariants + dashboards nominal after rollback.

## Incident-response checklist

- [ ] Declare + assign Incident Commander / Comms / Ops.
- [ ] Classify: money incident (double charge/refund, oversell) → severity=page + finance on call.
- [ ] Mitigate via kill switches (flags) before deep debugging.
- [ ] Status-page update ≤ 15 min; updates every 30 min.
- [ ] Post-incident review ≤ 3 business days (template in docs/launch/).

## Support checklist

- [ ] Support runbook + macros for: refund request (manual, `MANUAL_ONLY`), failed payment,
      booking stuck, QR/ticket issue, check-in dispute.
- [ ] Refund path: support raises → finance/admin approves in the admin console (audited) →
      executor re-validates; **no auto-refund**.
- [ ] Escalation path to on-call for money/oversell signals.

## Organizer onboarding checklist

- [ ] KYC + payout account (Stripe Connect / Razorpay Route) verified.
- [ ] Organization + roles provisioned (tenant-scoped).
- [ ] Payout schedule + fee agreement recorded.

## Theatre onboarding checklist

- [ ] Venue + seat-layout imported; map validated against the physical house (no overlap/oversell).
- [ ] Show/session schedule + pricing tiers validated.
- [ ] Inventory ownership mode confirmed (local vs provider-authoritative) — provider confirmation
      stays OFF until validated.

## Monitoring checklist

- [ ] Prometheus scraping API + worker `/metrics`; both `up`.
- [ ] Booking-platform dashboard + infra dashboard loaded (P6.6).
- [ ] Alerts firing to the right channel; page vs warn verified with a test alert.
- [ ] Redis/Postgres exporters deployed (for RedisDown/PostgresDown alerts).
- [ ] Log aggregation (central sink) + retention configured; no PII in logs (verified P6.5/6.8).
