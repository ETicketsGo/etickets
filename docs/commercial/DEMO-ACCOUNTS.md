# ETicketsGo — Demo Accounts

Seeded accounts for demos, sales walkthroughs, and QA. Created by
`npm run db:seed` ([seed.ts](../../apps/api/prisma/seed.ts)). **Do not seed production**;
these are for non-production environments only.

Shared password for all seeded accounts: **`Password123!`**

| Role                       | Email                       | Use in a demo                                                                               |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| **Demo organizer (owner)** | `owner@eticketsgo.test`     | Full organizer journey: create events, pricing, inventory, dashboard, finance, offline ops. |
| Organizer manager          | `manager@eticketsgo.test`   | Manager-scoped organizer actions.                                                           |
| Check-in staff             | `checkin@eticketsgo.test`   | Gate check-in (online + offline pilot).                                                     |
| **Demo customer**          | `customer1@eticketsgo.test` | Full buyer journey: browse, book, pay (mock), wallet, tickets.                              |
| Second customer            | `customer2@eticketsgo.test` | Sharing/transfer and multi-user scenarios.                                                  |
| Platform admin             | `admin@eticketsgo.test`     | Admin console: reports, ops, payments config, audit.                                        |

The seed also creates a demo organization, venues, published events with sessions and
ticket types, bookings, tickets, and a movies catalogue — enough to demonstrate discovery,
booking, check-in, and reporting end to end. For the offline check-in pilot demo, use the
isolated pilot fixture: `npm run db:pilot` (see [PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md)).

## Suggested demo scripts

- **Buyer (2 min):** log in as `customer1@` → browse events → open an event → select tickets
  → checkout → pay (mock) → open the ticket wallet → show the QR.
- **Organizer (3 min):** log in as `owner@` → sales dashboard → create/edit an event
  (pricing + inventory) → attendees → finance/reports.
- **Admin (2 min):** log in as `admin@` → reports/analytics → ops health → audit trail.
- **Offline pilot (5 min):** `npm run db:pilot`, enable `OFFLINE_CHECKIN_ENABLED`, follow
  the pilot runbook (approve device → activation GO → offline scan → reconcile → NO_GO).

> Reminder: `OFFLINE_CHECKIN_ENABLED` and live payments stay **off** by default even in
> demo environments unless explicitly enabled for the demo.
