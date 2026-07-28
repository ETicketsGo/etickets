# ETicketsGo — API Documentation

## Interactive reference (source of truth)

The API is documented with **OpenAPI/Swagger**, generated from the code:

- **Swagger UI:** `GET /api/docs` (enabled in non-production; in production only when
  `ENABLE_SWAGGER=true`).
- It lists every route, DTO shape, and auth requirement, always in sync with the code.

## Conventions

- **Base path:** all routes are under `/api` (e.g. `/api/events`). The API is currently
  unversioned (additive-only contract; see [KNOWN-LIMITATIONS](../release/KNOWN-LIMITATIONS.md)).
- **Auth:** `Authorization: Bearer <accessToken>`. Obtain via `POST /api/auth/login`; refresh
  via `POST /api/auth/refresh` (rotating refresh tokens, reuse detection). Access token TTL
  ~15 min; refresh ~30 days.
- **Roles:** platform + org roles enforced by guards; org endpoints check live membership.
- **Validation:** request bodies/queries validated by zod; unknown keys are stripped.
- **Pagination:** list endpoints take `page` + `pageSize` (capped at 100) and return
  `{ data, meta }`.
- **Errors:** a normalized envelope `{ code, message, details, correlationId }`. Notable codes:
  `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
  `CONFLICT` (409), payment codes `PAYMENT_DECLINED` (402), `PAYMENT_PROVIDER_UNAVAILABLE` (503).
- **Rate limits:** global throttle; auth endpoints tightened (per IP); wallet generation capped.
- **Idempotency:** money/inventory/check-in transitions are idempotent and replay-safe.

## Client library

Frontends use the typed client in `packages/web-kit` (`api.ts`) — reuse it rather than raw
fetch. It centralizes auth, refresh, error mapping (`ApiRequestError.status`), and endpoint types.

## Webhooks

Payment providers call `POST /api/payments/webhook/:provider` (signed, idempotent,
replay-safe). Configure the provider's webhook secret in the payment config.

## Health & metrics

- `GET /api/health` (liveness), `GET /api/health/ready` (DB + Redis).
- `GET /api/metrics` (Prometheus). Worker exposes its own metrics port.

## Generating a static spec

The OpenAPI document is built at boot from decorators; export it from the running Swagger
endpoint if a static artifact is needed for external consumers.
