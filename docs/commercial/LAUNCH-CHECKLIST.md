# ETicketsGo — Commercial Launch Checklist

Cross-functional readiness for onboarding the first paying organizers. Pairs with the
technical [DEPLOYMENT-CHECKLIST](../release/DEPLOYMENT-CHECKLIST.md) and the
[PILOT-EXECUTION-PLAN](../launch/PILOT-EXECUTION-PLAN.md).

## Legal & policy (with counsel)
- ☐ [Terms & Conditions](TERMS-AND-CONDITIONS.md) finalized and published.
- ☐ [Privacy Policy](PRIVACY-POLICY.md) finalized; retention periods + DSAR process defined.
- ☐ [Refund Policy](REFUND-POLICY.md) finalized (fee-refundability + cancellation handling).
- ☐ [Organizer Agreement](ORGANIZER-AGREEMENT.md) finalized (payout schedule, tax, liability).
- ☐ Policy links wired into the product footer + checkout consent.

## Commercial
- ☐ Platform fee rates/tiers confirmed vs [PLATFORM-FEES.md](PLATFORM-FEES.md) defaults.
- ☐ Fee modes explained to organizers; pricing sheet ready.
- ☐ Payment provider(s) contracted; merchant onboarding path tested end to end.
- ☐ Payout schedule and reconciliation cadence agreed.

## Product & UX
- ☐ First-event creation walked as a new organizer (onboarding checklist, wizard, publish).
- ☐ Buyer journey walked on desktop + mobile (browse → book → pay → wallet → check-in).
- ☐ Demo accounts verified ([DEMO-ACCOUNTS.md](DEMO-ACCOUNTS.md)).
- ☐ Error/empty/loading states reviewed on key screens.

## Support & operations
- ☐ Support channels live ([SUPPORT-WORKFLOWS.md](SUPPORT-WORKFLOWS.md)); SLAs agreed.
- ☐ [FAQ](FAQ.md) published in the help center.
- ☐ Incident response + on-call rota set ([INCIDENT-RESPONSE](../launch/INCIDENT-RESPONSE.md)).
- ☐ Monitoring/alerting dashboards shared with the on-call team.

## Technical
- ☐ Production deploy validated ([DEPLOYMENT-CHECKLIST](../release/DEPLOYMENT-CHECKLIST.md)).
- ☐ Real secrets, TLS, backups, health checks green; flag-off posture confirmed.
- ☐ Payments live-readiness GO per provider (if accepting live payments at launch).
- ☐ Rollback + DR rehearsed ([ROLLBACK-CHECKLIST](../release/ROLLBACK-CHECKLIST.md),
  [DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md)).

## Go / No-Go
- ☐ Legal, Commercial, Product, Support, and Technical leads each sign off.
- ☐ Pilot organizer(s) selected and briefed.
- ☐ Launch communications ready ([LAUNCH-COMMUNICATIONS](../launch/LAUNCH-COMMUNICATIONS.md)).

**Launch when every section is checked and all leads have signed off.**
