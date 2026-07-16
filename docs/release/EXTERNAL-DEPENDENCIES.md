# ETicketsGo RC1 — External Dependency Checklist

Third-party services and credentials ETicketsGo relies on. **Required** = must exist to run;
**Conditional** = only when the corresponding feature is enabled (all fail closed / no-op
when unconfigured). Provide every secret via the secret manager or environment — never in
committed files, never to the browser.

## Required (core runtime)
| Dependency | Purpose | Config | Notes |
| --- | --- | --- | --- |
| **PostgreSQL 16** | System of record | `DATABASE_URL` | Managed instance with PITR/backups; run `prisma migrate deploy`. |
| **Redis 7** | Cache, BullMQ queue (holds/notifications), maintenance flag | `REDIS_URL` | Fail-open for cache/maintenance; queue/worker resume on reconnect. |
| **Node.js 20.x runtime** | API + worker + web servers | `.nvmrc` | Build images with `npm ci` against the committed lockfile. |
| **TLS / reverse proxy** | HTTPS termination | infra | Required for HSTS, secure cookies, camera/secure-context features. |

## Conditional — payments (only if accepting real payments)
| Dependency | Purpose | Config | Gate |
| --- | --- | --- | --- |
| **Stripe / Razorpay / PayPal / Square** | Payment processing | `PAYMENT_PROVIDER_NAME` + provider keys/`*_REF` | Live requires `PAYMENT_LIVE_ENABLED=true` + ACTIVE merchant + PASS certification + readiness GO. |
| **Provider webhooks** | Async payment status | `/api/payments/webhook/:provider` + webhook secrets | Idempotent, replay-safe handlers. |
| **Secret manager** (AWS/Azure/GCP) | Resolve `*_REF` secret references | `SECRET_MANAGER_PROVIDER`, region/vault/project vars | `env` backend is **rejected** in STAGING/PRODUCTION. |

## Conditional — notifications (default `log`; configure to actually deliver)
| Channel | Providers | Config |
| --- | --- | --- |
| Email | SendGrid / AWS SES | `EMAIL_PROVIDER`, `SENDGRID_API_KEY` / AWS creds, `EMAIL_FROM` |
| SMS | Twilio | `SMS_PROVIDER=twilio`, `TWILIO_*` |
| WhatsApp | Meta Cloud API | `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_*` |
| Push | FCM | `PUSH_PROVIDER=fcm`, `FCM_*` |

Each channel defaults to `log` (no external calls); if a provider is selected but its keys
are missing, construction fails fast with a key-named error.

## Conditional — wallet passes (off by default, fail closed)
| Dependency | Purpose | Config |
| --- | --- | --- |
| **Apple Wallet** issuer cert | Apple pass generation | `WALLET_APPLE_*` (`*_REF` for cert) |
| **Google Wallet** service account | Google pass generation | `WALLET_GOOGLE_*` (`*_REF` for SA) |

No real issuer credentials ship with RC1; both providers report `unavailable` until configured.

## Conditional — observability (optional; no-op unless set)
| Dependency | Purpose | Config |
| --- | --- | --- |
| **Sentry** | Error tracking (5xx only, no PII) | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` |
| **OpenTelemetry collector** | Distributed tracing | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` |
| **Prometheus / Grafana** | Metrics scraping + dashboards | scrape `/api/metrics` + worker metrics |

## Object storage
| Dependency | Purpose | Config |
| --- | --- | --- |
| **Storage driver** | Uploaded assets | `STORAGE_DRIVER` (default `local`) | Point at durable object storage in production. |

## Go-live dependency gate
- ☐ All **Required** dependencies provisioned and reachable (readiness probe green).
- ☐ Every **Conditional** dependency you enable has real, non-placeholder credentials via
  the secret manager.
- ☐ Anything left unconfigured is deliberate and verified fail-closed/no-op.
