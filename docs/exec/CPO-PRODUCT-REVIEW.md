# Chief Product Officer — Product Review & Plan

Customer-value review of every journey, a prioritized roadmap, and the quarterly
product plan. **No engineering redesign** — every item improves an existing,
shipped capability. Builds on the journey maps in the
[Organizer Success Playbook](../gtm/ORGANIZER-SUCCESS-PLAYBOOK.md).

## Prioritization framework

Each opportunity is scored 1–5 on five axes; **Priority = (Impact + Revenue +
Delight + Retention) × weight ÷ Effort**. We ship highest-priority, lowest-effort
first ("time-to-value" bias).

| Axis      | Meaning                                                |
| --------- | ------------------------------------------------------ |
| Impact    | Breadth × depth of the pain removed                    |
| Effort    | Build cost (1 = tiny, 5 = large) — **lower is better** |
| Revenue   | Direct effect on GMV/take-rate/conversion              |
| Delight   | "Wow"/word-of-mouth                                    |
| Retention | Effect on repeat + churn                               |

---

## Journey friction → prioritized improvements

### Organizer

| Friction                   | Improvement                                                        | I/E/R/D/Ret | Priority |
| -------------------------- | ------------------------------------------------------------------ | ----------- | -------- |
| Blank-canvas setup         | Persona **templates** + duplicate/recurring                        | 5/2/4/4/5   | **P0**   |
| Payment setup feels heavy  | "Publish now, wire live payments later" + guided flow              | 5/2/5/4/4   | **P0**   |
| Leaves platform to promote | Share links, **QR poster generator**, embed widget, WhatsApp share | 4/2/3/5/3   | **P0**   |
| "Did I get paid right?"    | Organizer-facing payout + settlement summary view                  | 4/2/4/3/4   | **P1**   |
| One-and-done               | Seasonal templates + "run it again" nudges                         | 3/2/3/3/5   | **P1**   |

### Attendee

| Friction          | Improvement                                                                 | Priority |
| ----------------- | --------------------------------------------------------------------------- | -------- |
| Checkout drop-off | Localized methods, Apple/Google Pay, guest checkout, idempotent retry       | **P0**   |
| "Did it work?"    | Instant QR + email/SMS/WhatsApp confirmation (exists) — surface prominently | **P0**   |
| No-shows          | Automated reminders + waitlist                                              | **P1**   |
| Tier confusion    | Clearer tier UI + recommendations                                           | **P2**   |

### Movie customer

| Friction                | Improvement                                    | Priority |
| ----------------------- | ---------------------------------------------- | -------- |
| Slow seat map on mobile | Seat-map performance + visible hold timer      | **P0**   |
| Showtime discovery      | Cleaner showtime/format (2D/3D/IMAX) selection | **P1**   |
| Add-ons (F&B) missing   | F&B/combo add-on at checkout (monetization)    | **P1**   |

### Event organizer

| Friction                   | Improvement                                 | Priority |
| -------------------------- | ------------------------------------------- | -------- |
| Complex tiers/discounts    | Richer coupons/early-bird/group discount UX | **P1**   |
| Multi-session/track events | Session/track management surfacing          | **P1**   |
| Sponsor value              | Sponsor placement + reporting surface       | **P2**   |

### Cinema owner

| Friction              | Improvement                                               | Priority |
| --------------------- | --------------------------------------------------------- | -------- |
| Own-brand app         | White-label branding + embed (exists) — package + promote | **P1**   |
| Multi-screen ops      | Unified multi-screen reporting/settlement view            | **P1**   |
| Aggregator dependence | Migration assist + "own your audience" onboarding         | **P1**   |

### Admin

| Friction             | Improvement                                                        | Priority    |
| -------------------- | ------------------------------------------------------------------ | ----------- |
| Config safety        | Fail-closed validation + readiness gate (exists) — surface clearly | **Done/P2** |
| Cross-org visibility | Admin dashboards depth (already strong) — polish                   | **P2**      |

### Finance

| Friction         | Improvement                                                            | Priority |
| ---------------- | ---------------------------------------------------------------------- | -------- |
| Trust in numbers | Settlement summary + immutable fee snapshots (exists) — organizer view | **P1**   |
| Discrepancies    | Reconciliation queue (exists) — org-relevant surfacing                 | **P1**   |
| Tax/receipts     | Per-region tax receipts                                                | **P2**   |

### Support

| Friction           | Improvement                                     | Priority |
| ------------------ | ----------------------------------------------- | -------- |
| Repetitive tickets | In-product help + top-20 KB deflection          | **P0**   |
| Event-day risk     | Readiness checks + status surfaced to organizer | **P1**   |

---

## Product roadmap (value-driven, non-speculative)

### Now (Q1) — time-to-value & activation

- Persona templates + duplicate/recurring experiences.
- "Publish now, pay-live later" onboarding; guided provider connect.
- Promotion kit: share links, QR poster, embed widget, WhatsApp share.
- Checkout conversion: wallets/Apple-Google Pay surfacing, guest checkout, retry UX.
- In-product help + top-20 KB.

### Next (Q2) — monetization & retention

- Organizer payout/settlement view; reconciliation surfacing.
- Seasonal templates + re-engagement nudges.
- F&B/add-on upsell at checkout (movies + events).
- Richer discounts/coupons UX; waitlists.
- White-label packaging + migration assist.

### Later (Q3–Q4) — depth & expansion

- Multi-screen/chain reporting + settlement.
- Per-region tax receipts.
- Integrations (CRM/accounting/POS) marketplace.
- Sponsor placement + reporting; memberships/seasons surfacing.
- AI where ROI is measurable (see [AI Strategy](./AI-STRATEGY.md)).

## Feature prioritization (top 10, ranked)

1. Persona templates + duplicate/recurring — **P0** (activation + retention).
2. Publish-now/pay-live-later onboarding — **P0** (activation).
3. Promotion kit (share/QR/embed) — **P0** (delight + conversion).
4. Checkout conversion pack — **P0** (revenue).
5. In-product help + KB deflection — **P0** (support cost).
6. Organizer payout/settlement view — **P1** (trust + retention).
7. F&B/add-on upsell — **P1** (revenue).
8. Discounts/coupons + waitlist UX — **P1** (revenue + no-shows).
9. White-label packaging + migration — **P1** (revenue + cinemas).
10. Seasonal re-engagement — **P1** (retention).

## Quarterly product plan (Q1)

- **Theme:** _Activation & time-to-value._ Ship the five P0s.
- **Objective:** median time-to-first-publish < 15 min; 7-day activation ≥ 60%;
  checkout conversion ≥ benchmark; KB deflection ≥ 50%.
- **Cadence:** weekly build review vs pilot friction; you-asked-we-shipped loop;
  every release note goes to the pilot cohort.
- **Guardrail:** no change may regress payment success, refunds, or reliability.

## Product KPIs

Activation (signup→publish→first sale), time-to-first-publish, checkout conversion,
feature adoption (templates, promotion kit, add-ons), repeat experiences per
organizer, refund rate, NPS/CSAT, KB deflection.

## Success metrics (targets)

| Metric                             | Target                    |
| ---------------------------------- | ------------------------- |
| Time-to-first-publish (median)     | < 15 min                  |
| 7-day activation                   | ≥ 60%                     |
| Checkout conversion                | ≥ market benchmark        |
| Repeat organizers (2nd experience) | ≥ 40% by M3               |
| Add-on attach rate                 | establish baseline → grow |
| NPS                                | ≥ 40                      |
| KB deflection                      | ≥ 50%                     |

_Focus is customer value, not new architecture. Every roadmap item leverages a
capability that already ships._
