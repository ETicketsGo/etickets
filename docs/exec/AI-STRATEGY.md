# Chief AI Officer — AI Strategy (ROI-first)

**Principle: we do not build AI because it is fashionable.** Every AI investment
must map to a **measurable business metric** (conversion, GMV, take-rate, support
cost, no-shows, fraud loss, forecast accuracy) with a baseline and a target. If we
can't measure the lift, we don't ship it.

ETicketsGo already ships a **recommendations/discovery** engine and rich structured
data (bookings, seats, payments, comms, analytics) — the substrate for measurable AI.

## Evaluation framework

Score each use case on **Value (measurable $/metric)**, **Feasibility (data + effort)**,
**Risk (money/trust/safety)**. Ship only where Value is high, Feasibility is real,
and Risk is controllable. Every deployment is an **experiment with a control group**
and a kill-switch.

| Use case                                       | Primary metric                             | Value    | Feasibility          | Risk                      | Verdict                         |
| ---------------------------------------------- | ------------------------------------------ | -------- | -------------------- | ------------------------- | ------------------------------- |
| **Recommendations**                            | conversion, GMV/session, add-on attach     | High     | High (engine exists) | Low                       | **Build (now)**                 |
| **Search** (semantic discovery)                | discovery→booking conversion               | Med–High | Med                  | Low                       | **Build (near)**                |
| **Customer support** (assist/deflect)          | deflection %, first-response, CSAT         | High     | High (KB exists)     | Med (accuracy)            | **Build (near)**                |
| **Organizer Copilot** (setup/insights)         | time-to-publish, activation, repeat        | High     | Med                  | Med                       | **Build (staged)**              |
| **Fraud detection**                            | fraud/chargeback loss, false-positive rate | High     | Med (needs volume)   | Med–High                  | **Build (when data)**           |
| **Forecasting** (demand/no-show/capacity)      | sell-through, no-show, staffing accuracy   | Med–High | Med (needs history)  | Low–Med                   | **Build (when data)**           |
| **Pricing** (dynamic/recommended)              | revenue/seat, sell-through                 | Med      | Med                  | **High** (trust/fairness) | **Assist-only, guarded**        |
| **Marketing** (copy/segments/send-time)        | campaign conversion, CAC                   | Med      | High                 | Low–Med                   | **Build (near, human-in-loop)** |
| **Operations** (anomaly/routing/summarization) | MTTR, ops effort, reconciliation triage    | Med      | Med                  | Low                       | **Build (staged)**              |

## Where AI creates measurable value (ranked)

1. **Recommendations & search** — most direct GMV lift; measure conversion + add-on
   attach with holdouts. _Build first; it already exists to extend._
2. **Support assist/deflection** — cut cost + response time; measure deflection +
   CSAT vs control; always human-escalation + cite KB (avoid hallucination on money).
3. **Organizer Copilot** — draft events from a prompt, suggest pricing/capacity,
   surface "what's working" insights; measure time-to-publish + activation + repeat.
4. **Marketing assist** — generate copy/segments/send-time; human-approved; measure
   campaign conversion.
5. **Fraud detection** — once GMV/volume supports models; measure fraud loss +
   false-positive rate; complements existing reconciliation/audit controls.
6. **Forecasting** — demand/no-show/capacity once history exists; measure accuracy →
   staffing + inventory decisions.
7. **Ops intelligence** — anomaly detection on payments/queues, reconciliation
   triage suggestions, incident summarization; measure MTTR + ops effort.

## Guardrails (non-negotiable)

- **Money & trust:** AI never auto-moves money, never auto-issues refunds, never
  auto-corrects financial records, and never sets a live price without human
  approval. It **assists**; humans decide on anything financial.
- **Accuracy on support:** answer from the KB/product context with citations; escalate
  on uncertainty; measure and cap error rate.
- **Privacy & fairness:** respect data ownership + consent; no sensitive-attribute
  targeting; pricing AI must be fair/transparent (regulatory + brand risk).
- **Measurable-only:** every model ships with a baseline, a target metric, a control
  group, monitoring, and a kill-switch. No metric, no launch.
- **Cost discipline:** track inference cost per outcome; AI must be net-positive
  after cost.

## 3-year AI roadmap

### Year 1 — Prove value on conversion + cost (low risk)

- **Recommendations 2.0:** extend the existing engine (content + behavior + add-on
  cross-sell). _KPI: +X% conversion / GMV-per-session (holdout)._
- **Semantic search:** natural-language discovery of experiences. _KPI: discovery→
  booking conversion._
- **Support assist:** KB-grounded answer assist + suggested replies + deflection
  (human escalation always). _KPI: deflection %, first-response, CSAT._
- **Marketing assist (human-in-loop):** copy, segments, send-time suggestions.
  _KPI: campaign conversion._
- Establish the **measurement harness** (baselines, holdouts, cost tracking).

### Year 2 — Copilot + intelligence (medium risk, data-backed)

- **Organizer Copilot:** draft an event from a prompt; suggest pricing/capacity/
  tiers; "what's working" insights; event-day readiness assistant. _KPI: time-to-
  publish, activation, repeat rate._
- **Fraud detection:** models over transaction/behavior signals feeding the existing
  reconciliation/circuit controls. _KPI: fraud/chargeback loss, false-positive rate._
- **Forecasting:** demand, sell-through, no-show, staffing. _KPI: forecast accuracy →
  decisions._
- **Pricing assist (guarded):** recommend prices; **human approves**; never
  auto-live. _KPI: revenue/seat, sell-through, with fairness monitoring._

### Year 3 — Optimize + operationalize (scale, still measured)

- **Ops intelligence:** anomaly detection (payments/queues), reconciliation-triage
  suggestions, incident summarization. _KPI: MTTR, ops effort._
- **Personalized attendee lifecycle:** AI-optimized reminders/win-back/recs to cut
  no-shows + grow repeat. _KPI: no-show rate, repeat attendee rate._
- **Autonomy where proven-safe only:** expand automation strictly where a metric +
  guardrail history justifies it (never money-moving without human control).
- **Continuous experimentation:** every AI feature under ongoing A/B with cost/ROI
  review; retire anything not net-positive.

## AI KPIs (portfolio)

Per feature: metric lift vs control, adoption, inference cost per outcome, error/
false-positive rate, and net ROI. Portfolio: % of AI features that are net-positive
(target 100% — kill the rest), incremental GMV + support-cost savings attributable
to AI, fraud loss avoided, forecast accuracy.

## Build vs buy

- **Buy/foundation-model + RAG** for language tasks (support assist, copilot,
  marketing copy) — fastest, cheapest, grounded in our data.
- **Build lightweight models** for recommendations, fraud, forecasting where our
  proprietary data is the edge.
- **Never** build bespoke infra for a use case whose ROI isn't first proven with a
  bought/managed component.

_Bottom line: AI is a set of measured bets that compound the platform's data
advantage — starting with recommendations, search, and support where ROI is clearest
and risk is lowest, and only ever assisting (never autonomously deciding) on money._
