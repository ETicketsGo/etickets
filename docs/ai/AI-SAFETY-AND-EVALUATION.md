# AI & Growth — Safety and Evaluation (v2.0)

ETicketsGo's AI layer is **assistive, advisory, and disabled by default**. Every feature
ships a deterministic engine that is authoritative; a provider (when configured) may only
rephrase those facts. This document records the safety envelope, the evaluation framework,
external dependencies, and known limitations.

## Posture

- **Disabled by default.** `AI_PROVIDER=disabled` unless explicitly configured. No provider
  SDK is bundled and no response is ever faked. With AI disabled, every feature returns its
  deterministic result and the `AiGateway` records a `disabled`/`fallback` usage row.
- **Advisory only.** Nothing the AI layer produces modifies pricing, inventory, events,
  coupons, payments, publishing state, or accounts. Risk signals never cancel, suspend, or
  block. Recommendations are suggestions with evidence.
- **Tenant-scoped.** The organizer assistant sources answers exclusively from
  `AnalyticsService.organizer()` / `ReportsService.*`, which call
  `OrgAccessService.assertMember()` — a cross-tenant question throws `TENANT_FORBIDDEN`.
- **No raw payment data or unnecessary PII.** Inputs are aggregate metrics. The gateway
  additionally redacts emails, phone numbers, long digit runs (card/id-like) and booking
  references before any text could reach a provider.

## Safety envelope (every AI call routes through `AiGateway.run`)

1. Disabled-by-default gate → deterministic fallback.
2. PII redaction (`redactPii`) on all input; redaction count recorded as a safety event.
3. Timeout (`AI_TIMEOUT_MS`, default 8s) and bounded retries (`AI_MAX_RETRIES`, default 1).
4. Usage/cost/latency telemetry (`AiUsage`) — never the prompt or payload.
5. Fail-safe: any failure returns `{ ok:false, fallback:true }`; the gateway never throws
   into a caller.

## Evaluation framework (automated)

| Requirement                                   | Where                                                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden test cases                             | `packages/web-kit/src/ai-growth.spec.ts` (summary, recommendations, risk, search)                                                                                                                              |
| Structured-output validation                  | Engines return typed structures; asserted per test                                                                                                                                                             |
| Hallucination checks vs authoritative metrics | Summary/recommendation tests assert numbers equal the input metrics; no fabrication path exists (facts come from analytics/reports, not the model)                                                             |
| PII-redaction tests                           | `ai-growth.spec.ts` (`redactPii`) + `ai-gateway.service.spec.ts` (redaction before provider)                                                                                                                   |
| Prompt-injection resistance                   | The assistant computes from analytics, not from the question text; the model (if enabled) only rephrases and is instructed to answer solely from provided facts. Injected instructions cannot change a metric. |
| Provider-unavailable tests                    | `ai-gateway.service.spec.ts` — unavailable/failure → deterministic fallback                                                                                                                                    |
| Deterministic fallback tests                  | `ai-gateway.service.spec.ts` — disabled posture returns fallback and records usage                                                                                                                             |
| Cost & latency budgets                        | `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_COST_PER_1K_MINOR`; surfaced in the admin AI Console                                                                                                                    |
| Tenant isolation                              | Enforced by `OrgAccessService.assertMember` in the analytics/reports the assistant reuses (covered by their specs)                                                                                             |

## External dependencies

- **None required.** No AI SDK, key, or network egress is needed to run the platform; all
  AI features have deterministic fallbacks.
- **Optional (not bundled):** a real provider (OpenAI/Anthropic) behind `selectAiProvider`.
  Wiring one requires adding its SDK + `AI_API_KEY` and a transport class; until then,
  `AI_PROVIDER` values other than `disabled` fall back to the disabled provider (logged).

## Known limitations

- **AI rephrasing is not shipped** — the provider seam is complete but no model transport is
  bundled, so `generated` is always `false` today. This is intentional (no fake integrations).
- **Risk signals** rely on data the platform captures. Booking-time IP/device velocity is
  **not** available (bookings store no IP); signals use buyer-email/user velocity, payment
  failures, refund pressure, coupon usage and transfer velocity instead. Login IP exists only
  on `RefreshToken`.
- **Search date intent** is interpreted and shown, but the public events API does not filter
  by date range, so date phrases refine the display, not the query.
- **Customer recommendations** remain deterministic (existing strategies); per-item natural
  "why" text and cross-session collaborative filtering are future provider-gated work.
- **Currency** in summaries defaults to INR (the platform default); multi-currency labelling
  is a follow-up.
- **Cost figures** are estimates from `AI_COST_PER_1K_MINOR` × token counts, not billed
  amounts.

## UX contract

AI surfaces are labeled ("Suggested", "Based on current data", "Consider", "Possible risk",
"Draft"), optional, explainable (metric + reason + evidence), dismissible, accessible, and
mobile-responsive. They never use guaranteed/definitely/automatic language.
