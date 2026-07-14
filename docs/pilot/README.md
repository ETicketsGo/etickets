# ETicketsGo — Pilot Program Documentation

This folder holds the guides and playbooks used to onboard and support the
**first real customers** of ETicketsGo during the pilot. It is task-oriented
(numbered steps, real routes and endpoints) and honest about what is live versus
mocked or pending.

> Screenshots are marked `![screenshot: …]` as placeholders — capture them from
> the running apps before sharing externally.

## The nine documents

| #   | Document                                       | Audience                       | Purpose                                                                      |
| --- | ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| 1   | [PILOT-GUIDE.md](./PILOT-GUIDE.md)             | Program owner, leadership      | Goals, scope (live vs mock), timeline, success metrics, exit criteria        |
| 2   | [ORGANIZER-GUIDE.md](./ORGANIZER-GUIDE.md)     | Pilot organizers               | End-to-end: sign-up → venue/event/movie → publish → team → reports → payouts |
| 3   | [ADMIN-GUIDE.md](./ADMIN-GUIDE.md)             | Platform admins                | Approvals, bookings/payments, refunds, payouts, reports, ops console, audit  |
| 4   | [CHECKIN-GUIDE.md](./CHECKIN-GUIDE.md)         | Gate / check-in staff          | QR scanning, result states, edge cases, reversal, escalation                 |
| 5   | [CUSTOMER-GUIDE.md](./CUSTOMER-GUIDE.md)       | End customers (support-facing) | Discover → book → pay → QR ticket → refund → help                            |
| 6   | [SUPPORT-PLAYBOOK.md](./SUPPORT-PLAYBOOK.md)   | First-line support             | Triage, common issues → resolutions, what support can/can't do, SLAs         |
| 7   | [INCIDENT-RESPONSE.md](./INCIDENT-RESPONSE.md) | On-call, engineering           | Severity levels, response flow, rollback, runbooks, comms templates          |
| 8   | [ESCALATION-MATRIX.md](./ESCALATION-MATRIX.md) | Everyone                       | Issue × severity → owner → contact → response target                         |
| 9   | [LAUNCH-CHECKLIST.md](./LAUNCH-CHECKLIST.md)   | Program owner                  | Pilot go/no-go checklist (distinct from prod GO-LIVE)                        |

## How the pilot docs relate to the existing docs

These pilot docs **link to, and do not duplicate**, the production reference set:

- Deployment & environments → [docs/guides/DEPLOYMENT.md](../guides/DEPLOYMENT.md)
- Production go-live gate → [docs/reports/GO-LIVE-CHECKLIST.md](../reports/GO-LIVE-CHECKLIST.md)
- Day-2 operations → [docs/reports/OPERATIONS.md](../reports/OPERATIONS.md)
- Disaster recovery → [docs/reports/DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md)
- First-line support reference → [docs/reports/SUPPORT-HANDBOOK.md](../reports/SUPPORT-HANDBOOK.md)
- Monitoring & alerting → [docs/guides/MONITORING.md](../guides/MONITORING.md)
- Payment provider wiring → [docs/guides/PAYMENT-INTEGRATION.md](../guides/PAYMENT-INTEGRATION.md)
- Notifications wiring → [docs/guides/NOTIFICATION-INTEGRATION.md](../guides/NOTIFICATION-INTEGRATION.md)
- Architecture, runbooks → [docs/handbooks/](../handbooks/)

## Product surface at a glance (pilot)

Three web apps + one API. The API runs under the `/api` global prefix
(`API_GLOBAL_PREFIX`, default `api`).

- **customer-web** — public discovery, booking, tickets, help.
- **organizer-web** — `/organizer/*` dashboard for organizers and their staff.
- **admin-web** — `/admin/*` console for platform admins.

**Roles** (`Role` enum): `CUSTOMER`, `ORGANIZER_OWNER`, `ORGANIZER_MANAGER`,
`CHECKIN_STAFF`, `ADMIN`, `SUPER_ADMIN`.
