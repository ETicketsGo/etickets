# ETicketsGo — Organizer Guide

How to run events on ETicketsGo, from onboarding to payout.

## Getting started
1. Create an organizer account; the **onboarding checklist** guides your first steps
   (create a venue, load a sample event, etc.).
2. Complete **payment onboarding** (merchant account / KYC) to receive live payouts — see
   [MERCHANT-ONBOARDING.md](MERCHANT-ONBOARDING.md).

## Creating your first event
Use the **event wizard** (`/organizer/events/new`), a 6-step flow:
1. **Basic details** — title, category, description, refund policy.
2. **Venue** — pick an existing venue or create one.
3. **Sessions** — one or more date/time sessions (end must be after start).
4. **Ticket types** — name, **price** (validated), quantity, max per order.
5. **Fee handling** — choose who pays fees (customer / organizer / shared); see
   [PLATFORM-FEES.md](../commercial/PLATFORM-FEES.md).
6. **Review** — save as draft or submit for review/publish.

Edit an event from its page (status-gated — pause a live event before editing sensitive fields).

## Pricing, inventory & promotions
- **Pricing:** set per-ticket-type prices and the event fee mode.
- **Inventory:** track sold quantities per ticket type.
- **Coupons/promotions:** discount codes (percentage or fixed) are supported end to end at
  checkout. *(Organizer coupon-management UI is a planned enhancement; see the RC/known
  limitations — until then coupons can be provisioned by the platform.)*

## Selling & monitoring
- **Dashboard** — sales, revenue, attendance at a glance (single aggregate query, fast).
- **Orders / Attendees** — searchable, filterable tables; **Export CSV** exports the FULL
  filtered attendee list (your door list), not just one page.
- **Analytics / Reports** — sales by ticket type and by day, check-in counts.

## Check-in
- **Online check-in** — camera QR scan or manual entry; live attendance bar; reverse
  check-in; recent-scans history.
- **Offline gate check-in** — where enabled, follow the [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)
  (device approval → activation → offline scan → reconcile). The server always remains the
  entry authority.

## Finance & payouts
- **Payouts** — settlement rows (gross / fees / refunds / net / status).
- **Reconciliation** — the platform reconciles payments; discrepancies are triaged in finance.
- Proceeds settle to your verified account net of fees, refunds, and chargebacks
  ([Organizer Agreement](../commercial/ORGANIZER-AGREEMENT.md)).

## Support
See the [FAQ](../commercial/FAQ.md) and [SUPPORT-WORKFLOWS](../commercial/SUPPORT-WORKFLOWS.md).
