# ETicketsGo — Pilot Execution Guide

How to onboard the first organizers and customers and run a controlled pilot. Consolidates the
existing pieces — reference them, don't recreate:
[PILOT-EXECUTION-PLAN](PILOT-EXECUTION-PLAN.md) · [SUCCESS-METRICS](SUCCESS-METRICS.md) ·
[SUPPORT-PLAN](SUPPORT-PLAN.md) · [DEMO-ACCOUNTS](../commercial/DEMO-ACCOUNTS.md) ·
[FAQ](../commercial/FAQ.md) · [SUPPORT-WORKFLOWS](../commercial/SUPPORT-WORKFLOWS.md) ·
[ADMINISTRATOR-GUIDE](../guides/ADMINISTRATOR-GUIDE.md) · [ORGANIZER-GUIDE](../guides/ORGANIZER-GUIDE.md) ·
[USER-GUIDE](../guides/USER-GUIDE.md).

> No feature changes. This is operating procedure for a pilot cohort (5–10 organizers, invite-only).

## 1. Demo environment & data

A **staging** environment (not production) with realistic data for demos and organizer training.

- Base demo set: `npm run db:seed` — creates the demo organization, users (admin/owner/manager/
  check-in staff/customers), published events with General/Gold/VIP tiers, movies, and coupons.
  Credentials + accounts are in [DEMO-ACCOUNTS](../commercial/DEMO-ACCOUNTS.md).
- Experience Commerce demo: `npm run db:demo-commerce` — layers add-ons (merch/parking/F&B/donation)
  and VIP + Family bundles onto a published event, so demos show the full commerce cart. Idempotent.
- Movies: included in the base seed (a cinema + showtimes) for the movie-ticketing flow.

Do **not** run seeds against production ([deployment runbook](../release/PRODUCTION-DEPLOYMENT-RUNBOOK.md) §2).

## 2. Organizer onboarding (per pilot organizer)

1. Admin approves the organization (Admin → Organizers → Review) — sets it APPROVED.
2. Organizer completes their **public profile** (Settings → Public organizer profile): logo, cover,
   bio, website, socials, contact.
3. Organizer creates a **venue**, then an **event** → sessions → ticket types.
4. Optional: add **coupons** (Promotions), **add-ons/bundles** (Commerce tab), **marketing** assets
   (Promote tab: shareable link, QR, poster, email invite).
5. Submit for review → admin publishes. Walk through the **Assistant** tab (deterministic event
   summary + growth recommendations) so the organizer sees the analytics story.
6. Hand over the [ORGANIZER-GUIDE](../guides/ORGANIZER-GUIDE.md) and the pilot support channel.

## 3. Customer onboarding

- Customers register on the customer app, browse/search (smart search understands
  "comedy in Bengaluru this weekend"), book tickets + add-ons in one cart, pay (mock in pilot until
  live payments are certified), and receive QR tickets in their wallet.
- **PWA:** prompt install ("Add to home screen"); tickets + wallet work offline; opt into push alerts.
- Reference the [USER-GUIDE](../guides/USER-GUIDE.md) and [FAQ](../commercial/FAQ.md).

## 4. Email / notification templates

Transactional messages (booking confirmed, payment failed, event reminder, refund completed, ticket
transferred, attendee invites) render from the code-defined template service
(`apps/api/src/notifications/templates/`) and deliver via the configured channels (email + in-app
inbox by default; SMS/WhatsApp/push are provider-gated — see the
[Capability Inventory](../ops/CAPABILITY-INVENTORY.md)). No new templates are needed for the pilot;
verify the `EMAIL_PROVIDER` is set (or `log` for a dry run).

## 5. Admin operating during the pilot

Follow the [ADMINISTRATOR-GUIDE](../guides/ADMINISTRATOR-GUIDE.md) + the daily/weekly items in the
[OPERATIONS-CHECKLIST](../release/OPERATIONS-CHECKLIST.md). Daily: review new organizers/events,
payment failures, refunds, the AI Console risk signals (advisory), and the audit log. The admin
platform covers organizers, events, bookings, payments, refunds, payouts, reports, users, support,
audit, ops, and the AI console.

## 6. Feedback collection

- In-app: the customer **Feedback widget** (contact / bug / feature / CSAT) writes to the `Feedback`
  model; admins triage under Admin → Support.
- Structured pilot feedback: run weekly organizer + customer check-ins; log against
  [SUCCESS-METRICS](SUCCESS-METRICS.md) and capture themes in the
  [POST-LAUNCH-REVIEW-TEMPLATE](POST-LAUNCH-REVIEW-TEMPLATE.md).
- Track the pilot KPIs: activation (organizer publishes an event), conversion (browse→paid), refund
  rate, support volume, NPS/CSAT, and any commerce attach rate (add-ons/bundles per order).

## 7. Pilot exit criteria (→ public launch)

- ≥1 real paid booking end-to-end per pilot organizer (with live payments in a controlled test).
- Support volume manageable; no unresolved Sev-1/Sev-2 issues ([INCIDENT-RESPONSE](INCIDENT-RESPONSE.md)).
- Positive organizer + customer feedback; KPIs within target.
- The [Go/No-Go Production Report](../release/GO-NO-GO-PRODUCTION-REPORT.md) reads GO.
