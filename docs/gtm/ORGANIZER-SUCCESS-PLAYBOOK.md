# Organizer Success Playbook

Covers **Phase 2 (journeys)**, **Phase 3 (onboarding, <15 min)**, **Phase 5
(customer success)**, and **Phase 9 (feedback loop)**.

---

## Phase 2 — Customer journeys & friction points

Legend: 🔴 friction · 🟢 recommended improvement.

### Organizer journey

`Discover → Sign up → Onboard → Create experience → Configure payments → Publish →
Promote → Sell → Check-in → Reconcile → Payout → Repeat`

| Stage     | 🔴 Friction                                       | 🟢 Improvement                                                                                                       |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Sign up   | Unclear if it does _my_ use case (movie vs event) | Use-case picker on signup ("Movies / Events / Both") → tailored template                                             |
| Onboard   | Payment setup feels heavy                         | Default to platform/dummy in sandbox; defer live payment wiring until first publish; guided secret-ref/merchant flow |
| Create    | Blank-canvas paralysis                            | Templates per persona (fest, concert, conference, movie show, match day)                                             |
| Payments  | "Which provider? test vs live?"                   | Auto-suggest provider by country/currency; one-click "Test connection"; readiness checklist                          |
| Publish   | Fear of mistakes                                  | Preview + "publish checklist"; unpublish/edit safety                                                                 |
| Promote   | Leaves platform to share                          | Built-in share links, QR poster generator, embeddable widget, WhatsApp share                                         |
| Sell      | Anxiety about money                               | Live sales dashboard; real-time GMV; low-stock nudges                                                                |
| Check-in  | Staff confusion                                   | Simple scanner PWA, offline-tolerant, role-scoped                                                                    |
| Reconcile | "Did I get paid right?"                           | Settlement summary + reconciliation queue surfaced to organizer-relevant view                                        |
| Payout    | Opaque timing                                     | Clear payout schedule + status + statement                                                                           |
| Repeat    | Manual re-setup                                   | "Duplicate experience"; recurring shows; saved templates                                                             |

### Customer (attendee) journey

`Discover → Select → Seat/ticket → Pay → Confirm → Reminder → Attend → Refund?`

| Stage       | 🔴 Friction             | 🟢 Improvement                                                                              |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| Discover    | Trust/brand             | Organizer-branded pages; reviews/ratings (built-in)                                         |
| Select      | Confusing tiers         | Clear tier UI; recommendations                                                              |
| Seat/ticket | Slow seat map on mobile | Fast seat-map; hold timer visible; GA quick-buy                                             |
| Pay         | Drop-off at checkout    | Localized methods (UPI/cards/wallets); Apple/Google Pay; guest checkout; idempotent retries |
| Confirm     | "Did it work?"          | Instant QR + email/SMS/WhatsApp confirmation                                                |
| Reminder    | No-shows                | Automated reminders (email/SMS/WhatsApp/push)                                               |
| Attend      | Gate queue              | Fast QR scan                                                                                |
| Refund      | Frustration             | Self-serve refund request within policy; clear status                                       |

### Check-in staff journey

`Get access → Learn scanner → Scan → Handle edge cases → Report`

| 🔴 Friction                | 🟢 Improvement                                                 |
| -------------------------- | -------------------------------------------------------------- |
| App install/login friction | PWA, magic-link/role login, no app store                       |
| Duplicate/invalid scans    | Clear SUCCESS/DUPLICATE/INVALID/WRONG-SESSION feedback + sound |
| Spotty venue wifi          | Offline-tolerant scanning; sync on reconnect                   |
| No visibility              | Live checked-in count                                          |

### Finance team journey

`Configure fees → Watch sales → Reconcile → Handle discrepancies → Payout → Report/tax`

| 🔴 Friction      | 🟢 Improvement                                              |
| ---------------- | ----------------------------------------------------------- |
| Trust in numbers | Immutable fee snapshots; settlement summary; audit log      |
| Discrepancies    | Reconciliation discrepancy queue (assign/resolve/CSV/aging) |
| Payouts          | Payout status + statement export                            |
| Tax              | Fee/tax reporting + receipts (roadmap: per-region receipts) |

### Operations team journey

`Provision providers → Monitor health → Handle outages → Maintenance`

| 🔴 Friction        | 🟢 Improvement                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Provider incidents | Provider health, circuit breaker, failover controls, [outage runbook](../guides/PROVIDER-OUTAGE-RUNBOOK.md) |
| Go-live safety     | Payment-live readiness gate + launch gate                                                                   |
| Config drift       | Fail-closed validation; environment promotion with approvals                                                |

### Support team journey

See the [Support Playbook](./SUPPORT-PLAYBOOK.md).

---

## Phase 3 — Onboarding: publish in <15 minutes

### The 15-minute path (happy path)

| Min   | Step                                                                       | Design principle                                                  |
| ----- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0–2   | Sign up + pick use-case (Movies / Events / Both)                           | Fewest fields; social/email; use-case → template                  |
| 2–5   | Create experience from a **template** (title, date/venue, one ticket type) | Pre-filled fields; smart defaults; sample data toggle             |
| 5–8   | Set price + capacity + fee mode                                            | Inline fee preview ("attendee pays $X"); currency auto by country |
| 8–11  | Payments: accept in **sandbox instantly**; "Go live later" banner          | Don't block publish on live payment wiring                        |
| 11–13 | Preview + Publish (publish checklist)                                      | One screen; safe edit/unpublish                                   |
| 13–15 | Get share link + QR poster + embed                                         | Instant promotion assets                                          |

**Rule:** Nothing on the critical path may require credentials the organizer
doesn't have yet. Live payments = a **guided, resumable** task, not a blocker.

### Onboarding checklist (give to every new organizer)

- [ ] Account created; use-case selected
- [ ] First experience created from a template
- [ ] Ticket type(s) + price + capacity set
- [ ] Fee mode chosen (who pays the platform fee)
- [ ] Sandbox payment tested (mock)
- [ ] Experience previewed
- [ ] **Published** ✅ (target: <15 min to here)
- [ ] Share link + QR poster grabbed; posted to one channel
- [ ] (Before real money) Payment provider connected + **Test connection** green
- [ ] Payout destination + schedule confirmed
- [ ] Check-in staff invited; scanner tested with a comp ticket
- [ ] First real sale received → confirmation verified
- [ ] Reminder automation on

### Activation milestones (what we measure)

1. **Published** (first experience live) — primary activation.
2. **First ticket sold.**
3. **First real payout.**
4. **Second experience created** (retention signal).

---

## Phase 5 — Customer success

### Success motions by tier

| Tier                          | Motion                                         | Cadence                           |
| ----------------------------- | ---------------------------------------------- | --------------------------------- |
| Self-serve (long tail)        | In-app nudges, lifecycle emails, KB, community | Automated                         |
| Managed (mid)                 | Named CSM, onboarding call, event-day check-in | Weekly during pilot, then monthly |
| Strategic (chains/enterprise) | CSM + QBRs + roadmap input                     | Weekly → quarterly                |

### Customer Health Score (0–100)

Weighted, computed from platform signals:

| Signal                              | Weight | Healthy               |
| ----------------------------------- | ------ | --------------------- |
| Activation (published + first sale) | 20     | Done                  |
| Recency (last publish/sale)         | 15     | < 30 days             |
| Frequency (experiences / 90d)       | 15     | ≥ 2                   |
| GMV trend                           | 15     | Flat/up               |
| Payment success rate                | 10     | ≥ 95%                 |
| Refund rate                         | 10     | ≤ platform median     |
| Support load / sentiment (CSAT)     | 10     | Low tickets, CSAT ≥ 4 |
| Payout success + on-time            | 5      | 100%                  |

**Bands:** 🟢 80–100 (expand/reference) · 🟡 50–79 (nurture) · 🔴 <50 (at-risk →
CSM outreach playbook). Recompute weekly; trigger plays on band changes.

### Save/expand plays

- 🔴 No publish in 30d → "need help launching?" + template + 15-min call offer.
- 🔴 Payment failures high → ops outreach + provider check.
- 🟡 One-and-done organizer → "duplicate your event" nudge + seasonal templates.
- 🟢 High GMV + CSAT → ask for case study + 2 referrals + upsell Pro/white-label.

---

## Phase 9 — Customer feedback loop

| Instrument              | When                                       | Owner       | Action                                     |
| ----------------------- | ------------------------------------------ | ----------- | ------------------------------------------ |
| **NPS**                 | 30 days post-first-event, then quarterly   | CS          | Route promoters→referrals, detractors→CSM  |
| **CSAT**                | After each support resolution + post-event | Support     | <4 triggers follow-up                      |
| **Feature requests**    | In-app widget + community board            | Product     | Public roadmap voting                      |
| **Bug reports**         | In-app "report issue" (built-in feedback)  | Support→Eng | Severity SLA (see Support Playbook)        |
| **Customer interviews** | 5/month across segments                    | CPO/CS      | Persona validation, journey fixes          |
| **QBRs**                | Quarterly for managed/strategic            | CSM         | Value review + roadmap alignment           |
| **Roadmap voting**      | Continuous public board                    | Product     | Transparency; prioritize by segment impact |

**Closing the loop:** every shipped request/bug notifies the requester ("you asked,
we shipped"). Feedback → roadmap → release notes → re-engagement.
