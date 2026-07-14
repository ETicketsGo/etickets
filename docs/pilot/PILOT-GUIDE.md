# ETicketsGo — Pilot Program Guide

The overall plan for running the ETicketsGo pilot: what it is, who it's for, what
is genuinely live versus mocked, the timeline, the metrics we grade against, and
the criteria to graduate from pilot to general availability (GA).

> Companion index: [docs/pilot/README.md](./README.md).

---

## 1. Goals

1. Prove the **core money path** end-to-end with real organizers and real
   buyers: discover → book → pay → get a QR ticket → check in at the gate →
   settle payouts.
2. Validate that **atomic guarantees** hold under real load: no oversell, no
   double-charge, no double-refund, no double-payout.
3. Exercise the **operational muscles**: monitoring, support, incident response,
   refunds, and payouts — with a small blast radius.
4. Gather structured **feedback** (CSAT + qualitative) from organizers and
   customers to prioritise GA work.

## 2. Who it's for

- **1–3 pilot organizers** running a handful of real events and/or cinema shows.
- Their **staff** (managers + gate/check-in staff).
- A **small cohort of real customers** buying real tickets.
- The internal **platform team**: admins, first-line support, and an on-call
  engineer.

Keep the cohort deliberately small — the pilot is about depth and confidence, not
volume.

## 3. Scope — what is live vs mock

Be honest with pilot participants about this table. Everything marked **pending**
has working code paths but an unfinished last mile.

| Capability            | Status in pilot                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking & inventory   | **Live.** Atomic holds (10-minute TTL), seat maps for cinema, general admission for events.                                                                                                                                                       |
| Payments              | **Provider-switchable.** `PAYMENT_PROVIDER_NAME` selects `mock` (default, dev), `stripe`, or `razorpay`. Real charges require real keys — start in sandbox. See [PAYMENT-INTEGRATION](../guides/PAYMENT-INTEGRATION.md).                          |
| Email notifications   | **Production-ready** once an email transport is configured. See [NOTIFICATION-INTEGRATION](../guides/NOTIFICATION-INTEGRATION.md).                                                                                                                |
| SMS / WhatsApp / Push | **Pending recipient plumbing.** Channels + transports exist, but the platform does not collect phone numbers or push tokens yet, so these are a clean skip (warn + return), never an error.                                                       |
| QR check-in           | **Live**, online-only. There is **no offline scan queue** — scans fail while the device is offline.                                                                                                                                               |
| Refunds               | **Live.** 48-hour pre-session window; admin/owner approval.                                                                                                                                                                                       |
| Payouts               | **Live.** Generate → admin marks paid. Marking paid is a bookkeeping action; no bank rail is wired.                                                                                                                                               |
| Reports               | **Live**, with CSV export. **Tax is not modelled** — revenue figures are pre-tax.                                                                                                                                                                 |
| Enterprise modules    | **Flag-gated, off by default** (memberships, subscriptions, organizer CRM, marketing automation, dynamic pricing, white-label, sponsors, event templates, AI recommendations). Placeholder architecture only — do not promise these in the pilot. |
| Object storage        | **Not configured** — the ops health check reports storage as `not_configured`.                                                                                                                                                                    |

## 4. Timeline & phases

| Phase                           | Duration  | Focus                                                                                                                                                 |
| ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0 — Prep**              | Week 0    | Complete [LAUNCH-CHECKLIST](./LAUNCH-CHECKLIST.md). Sandbox payments, email, monitoring, on-call.                                                     |
| **Phase 1 — Organizer onboard** | Week 1    | Onboard pilot org(s): [ORGANIZER-GUIDE](./ORGANIZER-GUIDE.md). Create venue + first experience in **sandbox** payment mode. Admin reviews & approves. |
| **Phase 2 — Soft sale**         | Weeks 2–3 | Switch a single event to **live** payment keys. Sell to a controlled cohort. Watch metrics and support daily.                                         |
| **Phase 3 — Live event(s)**     | Weeks 3–4 | Run the real gate check-in. Reconcile bookings ↔ payments ↔ payouts. Run first payout.                                                                |
| **Phase 4 — Review & decide**   | Week 5    | Grade against success metrics and exit criteria (§6). Decide GA / extend / iterate.                                                                   |

## 5. Success metrics

Source these from the business reports (`/admin/reports`, `/admin/dashboard`) and
the Prometheus `/api/metrics` endpoint. See
[MONITORING](../guides/MONITORING.md) for the full catalog.

| Metric                | Definition / source                                                         | Pilot target (suggested)           |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| GMV                   | `etg_gmv_minor_total` (minor units) / reports daily-revenue                 | Trending, reconciles with provider |
| Bookings confirmed    | `etg_bookings_confirmed_total` vs `etg_bookings_created_total`              | Create→confirm ratio steady        |
| Payment success rate  | `etg_payments_succeeded_total` ÷ (succeeded + `etg_payments_failed_total`)  | ≥ 98% (excl. user cancels)         |
| Refund rate           | `etg_refunds_completed_total` ÷ confirmed bookings; reports refunds CSV     | < 5%                               |
| Check-in success rate | `etg_qr_checkin_success_total` ÷ (success + `etg_qr_checkin_failure_total`) | ≥ 95% first-scan                   |
| CSAT                  | Feedback widget `CSAT` (1–5) + `ORGANIZER_CSAT` in `/admin/support`         | ≥ 4.0 / 5                          |
| Incidents             | SEV1/SEV2 count (see [INCIDENT-RESPONSE](./INCIDENT-RESPONSE.md))           | 0 SEV1; SEV2 resolved in target    |

> Note: `/api/metrics` counters are cumulative since process start and reset on
> redeploy — use the reports/dashboard for period-over-period business numbers.

## 6. Onboarding a pilot organizer (program-owner steps)

1. **Confirm fit** and sign a lightweight pilot agreement (out of band).
2. Create their **organizer login** and organization (they self-register via
   organizer-web, or an admin verifies them in `/admin/organizers`).
3. Send them the [ORGANIZER-GUIDE](./ORGANIZER-GUIDE.md) and walk the
   `/organizer/onboarding` checklist together (organization → venue → team →
   experience).
4. Keep them in **sandbox payments** until Phase 2; then swap to live keys on a
   single event.
5. Add them to the **feedback loop** (§7) and the shared support channel.

## 7. Feedback loop

- **In-app feedback widget** — a floating "Feedback" button mounted app-wide on
  customer-web. A message with a star rating is recorded as a `CSAT`; a message
  without a rating is `GENERAL`.
- **Help forms** — `/help/contact`, `/help/bug`, `/help/feature` on customer-web
  submit `CONTACT` / `BUG` / `FEATURE` items.
- **Organizer CSAT** — captured as `ORGANIZER_CSAT`.
- **Surveys** — run short structured surveys at the end of each phase (out of
  band, e.g. a form) and log summary results as feedback for a single source of
  truth.
- **Where it lands** — everything above flows into the support inbox at
  `/admin/support` (`FeedbackKind`: CONTACT/BUG/FEATURE/GENERAL/CSAT/ORGANIZER_CSAT;
  status OPEN → TRIAGED → CLOSED). Triage per the
  [SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md).

## 8. Exit criteria — graduating from pilot to GA

Graduate only when **all** of these hold across at least one full real event:

- [ ] Money path proven end-to-end with **live** payments and a completed payout,
      reconciled against the provider with zero discrepancies.
- [ ] Payment success rate and check-in success rate met their targets (§5).
- [ ] **Zero unresolved SEV1**; any SEV2s were resolved within target and have
      postmortems.
- [ ] Refund rate within target and every refund respected the 48h window rules.
- [ ] CSAT ≥ target with no systemic complaint theme unaddressed.
- [ ] Support handled the load within suggested SLAs
      ([SUPPORT-PLAYBOOK](./SUPPORT-PLAYBOOK.md)); no recurring issue lacks a
      runbook.
- [ ] Backups verified and a restore rehearsed
      ([DISASTER-RECOVERY](../reports/DISASTER-RECOVERY.md)).
- [ ] Production [GO-LIVE-CHECKLIST](../reports/GO-LIVE-CHECKLIST.md) satisfied
      for the broader rollout.
- [ ] Decision recorded (GA / extend / iterate) with owners for any follow-ups.
