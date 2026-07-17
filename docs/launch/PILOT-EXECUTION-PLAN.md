# ETicketsGo — Production Pilot Execution Plan

Plan for onboarding the **first production organizers** onto ETicketsGo. Small, controlled,
measured. This is the commercial pilot; the offline check-in pilot is separate
([PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md)).

## Objective
Validate the end-to-end commercial flow (onboard → create event → sell → check in → settle)
with 1–3 friendly organizers and real customers, at low volume, before general availability.

## Phases

**Phase 0 — Readiness (T-2 weeks)**
- Complete the [LAUNCH-CHECKLIST](../commercial/LAUNCH-CHECKLIST.md) and
  [DEPLOYMENT-CHECKLIST](../release/DEPLOYMENT-CHECKLIST.md).
- Finalize legal ([commercial/](../commercial/)) and support ([SUPPORT-PLAN](SUPPORT-PLAN.md)).
- Select 1–3 pilot organizers; sign the Organizer Agreement; complete payment onboarding.

**Phase 1 — Organizer onboarding (T-1 week)**
- Guided onboarding: account, first event (draft), pricing, inventory.
- Verify merchant onboarding → live-readiness GO per provider.
- Dry-run a test booking end to end (mock or a small real transaction).

**Phase 2 — Soft launch (Week 1)**
- Publish 1–2 low-volume events; invite a controlled customer audience.
- Monitor dashboards + Sentry daily; hold a daily 15-min check-in with each organizer.
- Keep GA off; support on high alert.

**Phase 3 — Live event(s) (Week 2)**
- Run the actual event(s), including check-in (online; offline pilot only if separately certified).
- On-call engineer available; incident process armed ([INCIDENT-RESPONSE](INCIDENT-RESPONSE.md)).

**Phase 4 — Settle & review (Week 3)**
- Process payouts/settlement; reconcile finance.
- Run the [POST-LAUNCH-REVIEW-TEMPLATE](POST-LAUNCH-REVIEW-TEMPLATE.md).
- Decide GO/NO-GO for wider rollout.

## Guardrails
- Keep `PAYMENT_LIVE_ENABLED` on only for certified providers; `OFFLINE_CHECKIN_ENABLED` off
  unless the offline pilot is separately run.
- One region/market (India) for the commercial pilot.
- Cap concurrent pilot events; scale only after the review.

## Roles
Pilot lead · Engineering on-call · Support lead · Finance (payouts) · each pilot organizer's
point of contact.

## Success gate → wider rollout
Meets the [SUCCESS-METRICS](SUCCESS-METRICS.md) thresholds, no unresolved P1 incidents, clean
settlement, and positive organizer + customer feedback.
