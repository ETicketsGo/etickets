# Capability & Toggle Inventory

What each major capability is, whether it is **on by default**, the **config that enables/changes** it,
and its **graceful-off behavior**. Use this before a production launch to confirm the intended posture.
(Added in the v2.1 enterprise-readiness audit; consolidates flags previously spread across modules.)

## Runtime feature flags (`packages/shared-types/src/features.ts`)

Resolved server-side and exposed via `GET /api/capabilities`. Default-enabled unless noted.

| Flag                  | Default | Effect when off                                   |
| --------------------- | ------- | ------------------------------------------------- |
| `savedEvents`         | on      | Save/follow UI hidden                             |
| `reviews`             | on      | Ratings & reviews hidden                          |
| `organizerProfiles`   | on      | Public organizer profile hidden                   |
| `eventFaq`            | on      | Event FAQ section hidden                          |
| `experienceDiscovery` | on      | Discovery sections fall back to basic listing     |
| `community`           | on      | Community surfaces hidden                         |
| `aiRecommendations`   | **off** | Recommendations use deterministic strategies only |

## Config-gated capabilities (env, not the flag framework)

| Capability                                      | On by default?                                            | Enable / configure                                                                                                          | Graceful-off behavior                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI assistant / summaries / growth / content** | Deterministic engine **always on**; AI rephrasing **off** | `AI_PROVIDER` (default `disabled`), `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_COST_PER_1K_MINOR`     | With `disabled`, every feature returns its deterministic result; the gateway records a `disabled`/`fallback` usage row. No provider is bundled — naming one without a wired transport falls back to disabled (logged). AI generation endpoints are throttled 20/min/client. |
| **Admin AI Console**                            | Always available (admin-only)                             | —                                                                                                                           | Shows `provider: disabled` + deterministic-posture banner; usage/risk still populate from telemetry + platform data.                                                                                                                                                        |
| **Risk signals**                                | Always on (deterministic, advisory)                       | —                                                                                                                           | N/A — no provider needed; masked + audited; never takes action.                                                                                                                                                                                                             |
| **Browser Web Push**                            | **Off**                                                   | `WEBPUSH_PROVIDER` (default `log`), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                                | Without a VAPID public key the client hides the enable toggle; the `push` channel dispatch is a no-op placeholder. The in-app inbox + email still deliver.                                                                                                                  |
| **Native push (FCM)**                           | **Off**                                                   | `PUSH_PROVIDER` (default `log`), `FCM_*` keys                                                                               | Log transport (no external send).                                                                                                                                                                                                                                           |
| **Offline gate check-in**                       | **Off**                                                   | `OFFLINE_CHECKIN_ENABLED` (default false)                                                                                   | Operational endpoints 404; readiness/activation answer NO_GO.                                                                                                                                                                                                               |
| **Wallet passes (Apple/Google)**                | **Off**                                                   | `WALLET_{APPLE,GOOGLE}_ENABLED/MODE/...` (refs only)                                                                        | Providers report unavailable; buttons hidden.                                                                                                                                                                                                                               |
| **Payments — live**                             | Mock/dummy default                                        | `PAYMENT_PROVIDER_NAME` (default `mock`), `PAYMENT_LIVE_ENABLED` (default false), per-provider keys via secret-manager refs | Only the selected provider is constructed; live keys never activate with placeholder secrets.                                                                                                                                                                               |
| **Email / SMS / WhatsApp**                      | Log transports                                            | `EMAIL_PROVIDER` / `SMS_PROVIDER` / `WHATSAPP_PROVIDER` (+ keys)                                                            | Log transport when unset.                                                                                                                                                                                                                                                   |
| **Experience Commerce (add-ons/bundles)**       | **On** (organizers opt in per event)                      | — (data-driven: an event has add-ons/bundles or it doesn't)                                                                 | No add-ons/bundles → the cart is ticket-only, exactly as before. Seat-based (movie) sessions reject commerce lines.                                                                                                                                                         |
| **PWA install / offline wallet**                | On (customer-web)                                         | Served automatically; SW registers in production only                                                                       | Non-supporting browsers degrade to the normal web app; offline reads fall back to network.                                                                                                                                                                                  |

## Production hardening gate

`assertProductionHardening` (`apps/api/src/config/configuration.ts`) refuses to boot in
`NODE_ENV=production` / `APP_ENV` STAGING|PRODUCTION when core secrets (JWT access/refresh, QR
signing, payment webhook, manifest signing) are placeholder or `<24` chars, or when `CORS_ORIGINS`
is unset/localhost. Lower environments are unaffected.

## Recommended launch posture

- Keep AI, web push, native push, offline check-in and wallet passes **disabled** until their
  provider credentials are configured and verified (see each module's guide).
- Set real core secrets + `CORS_ORIGINS`, `PAYMENT_LIVE_ENABLED` only after certification, and a
  Redis-backed shared throttler before horizontal scale (see KNOWN-LIMITATIONS).
