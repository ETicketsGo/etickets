# ETicketsGo — Pilot Launch Checklist

The go/no-go checklist for **starting the pilot**. This is distinct from — and
narrower than — the production [GO-LIVE-CHECKLIST](../reports/GO-LIVE-CHECKLIST.md),
which gates the broader GA rollout. Complete this before Phase 1 of the
[PILOT-GUIDE](./PILOT-GUIDE.md).

Mark each item with an **owner** and **done / pending**. Don't start selling to
real customers until the money-path and monitoring items are done.

---

## 1. Pilot cohort

| Item                                                                                 | Owner | Status  |
| ------------------------------------------------------------------------------------ | ----- | ------- |
| Pilot organizer(s) selected and agreement signed                                     | _TBD_ | pending |
| Organizer(s) onboarded via `/organizer/onboarding` (org → venue → team → experience) | _TBD_ | pending |
| At least one experience created and **approved** by admin (`/admin/events`)          | _TBD_ | pending |
| Customer cohort identified for the soft sale                                         | _TBD_ | pending |

## 2. Payments

| Item                                                                  | Owner | Status  |
| --------------------------------------------------------------------- | ----- | ------- |
| Provider chosen and `PAYMENT_PROVIDER_NAME` set (`stripe`/`razorpay`) | _TBD_ | pending |
| **Sandbox keys** wired and a full test purchase completed             | _TBD_ | pending |
| Webhook endpoint (`/api/payments/webhook`) reachable and verified     | _TBD_ | pending |
| Fee mode confirmed per event (default CUSTOMER_PAYS)                  | _TBD_ | pending |
| Plan to swap to **live keys** on a single event for Phase 2           | _TBD_ | pending |
| Reference: [PAYMENT-INTEGRATION](../guides/PAYMENT-INTEGRATION.md)    | —     | —       |

## 3. Notifications

| Item                                                                         | Owner | Status  |
| ---------------------------------------------------------------------------- | ----- | ------- |
| Email transport configured; test confirmation email received                 | _TBD_ | pending |
| Team understands SMS/WhatsApp/push are **pending** (email-only in pilot)     | _TBD_ | pending |
| Reference: [NOTIFICATION-INTEGRATION](../guides/NOTIFICATION-INTEGRATION.md) | —     | —       |

## 4. Feature flags

| Item                                                                                                                                                                        | Owner | Status  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- |
| Live flags confirmed on (`savedEvents`, `reviews`, `organizerProfiles`, `eventFaq`, `experienceDiscovery`, `community`)                                                     | _TBD_ | pending |
| Enterprise flags confirmed **off** (memberships, subscriptions, organizerCrm, marketingAutomation, dynamicPricing, whiteLabel, sponsors, eventTemplates, aiRecommendations) | _TBD_ | pending |
| Verified in `/admin/ops` → `GET /api/admin/ops/flags` (read-only; env-based)                                                                                                | _TBD_ | pending |

## 5. Monitoring & alerting

| Item                                                                    | Owner | Status  |
| ----------------------------------------------------------------------- | ----- | ------- |
| `/api/metrics` scraped; dashboards up                                   | _TBD_ | pending |
| Alerts live (payment failures, 5xx, check-in failures, DB/slow queries) | _TBD_ | pending |
| Sentry receiving errors                                                 | _TBD_ | pending |
| `/api/health` + `/api/ready` + `/admin/ops` health verified green       | _TBD_ | pending |
| Reference: [MONITORING](../guides/MONITORING.md)                        | —     | —       |

## 6. Support & feedback

| Item                                                                          | Owner | Status  |
| ----------------------------------------------------------------------------- | ----- | ------- |
| `/admin/support` inbox monitored; owner + rota assigned                       | _TBD_ | pending |
| Feedback widget + `/help/*` forms verified end-to-end                         | _TBD_ | pending |
| Suggested SLAs agreed with cohort ([SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md)) | _TBD_ | pending |
| Phase-end survey drafted and ready to send                                    | _TBD_ | pending |

## 7. Incident readiness

| Item                                                                    | Owner | Status  |
| ----------------------------------------------------------------------- | ----- | ------- |
| On-call assigned incl. live-event coverage window                       | _TBD_ | pending |
| [ESCALATION-MATRIX](./ESCALATION-MATRIX.md) roster + contacts filled in | _TBD_ | pending |
| Team walked through [INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md)         | _TBD_ | pending |
| Maintenance mode tested (`POST /api/admin/ops/maintenance` on/off)      | _TBD_ | pending |

## 8. Data safety

| Item                                                            | Owner | Status  |
| --------------------------------------------------------------- | ----- | ------- |
| Automated Postgres backups + PITR enabled and verified          | _TBD_ | pending |
| Restore rehearsed (or dev `pg_dump` snapshot taken)             | _TBD_ | pending |
| Reference: [DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md) | —     | —       |

## 9. Smoke tests (run right before opening the sale)

Run against the pilot environment in **sandbox** payment mode:

| Test                                                                             | Owner | Status  |
| -------------------------------------------------------------------------------- | ----- | ------- |
| Customer registers/logs in; browses `/events` and `/movies`                      | _TBD_ | pending |
| Book an event: select tickets → 10-min hold → pay → `/booking/[id]/confirmation` | _TBD_ | pending |
| Book a movie: `/shows/[sessionId]` seat select → pay → confirmation              | _TBD_ | pending |
| QR ticket visible at `/account/tickets/[ticketId]`                               | _TBD_ | pending |
| Gate scan returns **SUCCESS**; a second scan returns **DUPLICATE**               | _TBD_ | pending |
| WRONG_SESSION and INVALID paths behave as documented                             | _TBD_ | pending |
| Refund request respects the 48h window; admin/owner approval settles it          | _TBD_ | pending |
| Organizer report + admin `/admin/reports` CSV export download works              | _TBD_ | pending |
| Payout generate → admin mark paid                                                | _TBD_ | pending |
| Feedback widget submission appears in `/admin/support`                           | _TBD_ | pending |

## 10. Go / no-go

| Item                                                          | Owner | Status  |
| ------------------------------------------------------------- | ----- | ------- |
| All money-path + monitoring + backup items above are **done** | _TBD_ | pending |
| Program Owner sign-off to open the sale                       | _TBD_ | pending |

> After the pilot succeeds, complete the production
> [GO-LIVE-CHECKLIST](../reports/GO-LIVE-CHECKLIST.md) before GA. Graduation
> criteria are in [PILOT-GUIDE](./PILOT-GUIDE.md) §8.
