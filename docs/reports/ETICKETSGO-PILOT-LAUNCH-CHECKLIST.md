# ETicketsGo — Pilot Launch Checklist

Gate for a **controlled pilot** (limited organizers, capped bookings). Every item is an explicit
sign-off. Do not launch with any **blocker** open. Money automation stays OFF for the pilot unless
P6.3 + P6.2 are complete and signed.

## Onboarding & setup

- [ ] Theatre/organizer onboarding completed (KYC, payout account: Stripe Connect / Razorpay Route).
- [ ] Event/show setup validated (dates, sessions, timezones).
- [ ] Seat-layout validation (map matches physical house; no overlapping/oversold zones).
- [ ] Price validation (face value, fees, taxes) — reconciled against organizer agreement.

## Payments & money

- [ ] Payment validation on **sandbox** complete (P6.2 matrix green) — **PENDING**.
- [ ] Refund policy approved + `BOOKING_REFUND_POLICY_VERSION` recorded (P6.3 §2) — **PENDING**.
- [ ] Tax/GST treatment approved (P6.3 §2.4) — **PENDING**.
- [ ] Settlement lookup wired + settlement approval (P6.3 §1) — **PENDING**.
- [ ] Auto-refund remains **OFF** (`MANUAL_ONLY`) unless all the above are signed.

## Operations & safety

- [ ] Customer support process + contacts live.
- [ ] Monitoring dashboards (P6.7) deployed; alerts routed to on-call.
- [ ] On-call rotation + incident contacts published.
- [ ] Rollback rehearsed (flags → safe defaults; see below).
- [ ] Backup/restore + DR rehearsal passed (P6.9) — **PENDING** (needs managed-PG).

## Kill switches (verified working before pilot)

- [ ] **Booking disable:** `BOOKING_ORCHESTRATOR_ENABLED=false` (or `_MODE=shadow`) → legacy path.
- [ ] **Payment disable:** provider maintenance flag / `PAYMENT_PROVIDER_NAME=mock` for freeze.
- [ ] **Provider confirmation disable:** `BOOKING_PROVIDER_CONFIRMATION_ENABLED=false`.
- [ ] **Refund disable:** `BOOKING_COMPENSATION_AUTO_REFUND_ENABLED=false` + `MANUAL_ONLY`.
- [ ] **Allocated inventory disable:** `BOOKING_ALLOCATED_INVENTORY_ENABLED=false`.

## Capacity & scope

- [ ] Capacity limits set from the P6.5 load baseline (not assumed).
- [ ] **Pilot booking cap** configured (hard ceiling on concurrent/total pilot bookings).
- [ ] First bottleneck (P6.5) known + headroom confirmed for the pilot cap.

## Security

- [ ] SEC-1 dependency remediation done or risk-accepted with justification (P6.8) — **PENDING**.
- [ ] Staging attack matrix (P6.8) executed fail-closed — **PENDING** (needs staging).

## Sign-off

- [ ] Product · [ ] Finance · [ ] Engineering · [ ] SRE/On-call · [ ] Security — all named + dated.

**Launch decision:** proceed only when all blockers are closed and the P6 hardening report verdict is
**GO** or a scoped **CONDITIONAL GO** the owner accepts for the pilot.
