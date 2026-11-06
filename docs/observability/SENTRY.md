# Sentry: coverage, privacy, releases and alerts

Status: API and worker changes on `feat/sentry-coverage`. Not deployed. Nothing is sent
anywhere until `SENTRY_DSN` is set (it is not set in any environment that this repository
can see; the owner holds the Sentry account).

## Coverage by surface

| Surface                                | Before                                                                                      | After this branch                                                                                                                | Still missing                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| API                                    | Unhandled 5xx (exception filter) + SDK defaults (uncaught exceptions, unhandled rejections) | Same, plus: every ops alert as an issue; `area`, `status`, `provider`, `provider_reason` tags; stronger scrub                    | Source maps (see Releases)                                                       |
| Worker                                 | Own init with a weaker scrub; job failures except `campaign-send`                           | The API's init and scrub (`service=worker` tag); ops alerts raised inside the worker; `campaign-send` once its retries are spent | Source maps                                                                      |
| customer-web, organizer-web, admin-web | Nothing                                                                                     | Nothing                                                                                                                          | Everything: see "Web apps"                                                       |
| Android (Expo)                         | `@sentry/react-native` 7.11, config-gated on `EXPO_PUBLIC_SENTRY_DSN`                       | Unchanged                                                                                                                        | Explicit release/dist; key-based redaction misses phone/email/UPI (see "Mobile") |
| iOS (native, apps/customer-ios)        | Nothing                                                                                     | Nothing                                                                                                                          | SDK (sentry-cocoa)                                                               |

### What the API and worker now report

| Area                       | How it reaches Sentry                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript / server errors | 5xx from the exception filter, tagged `area`                                                                                      |
| Failed API requests        | 5xx only. Expected 4xx (validation, declines mapped to 402) are not errors                                                        |
| Checkout                   | `area=checkout` (bookings, quote, holds); `CONFIRMATION_FAILED_AFTER_PAYMENT` ops alert                                           |
| Payment initialisation     | Provider outage maps to 503 -> captured with `area=payments`, `provider`, `provider_reason`                                       |
| Webhook failures           | `WEBHOOK_SIGNATURE_REJECTED` and `WEBHOOK_DEAD_LETTERED` ops alerts; 5xx on `area=payments.webhook`                               |
| Captures not applied       | `CAPTURE_NOT_APPLIED`, `EXPIRY_FOUND_CAPTURE` ops alerts                                                                          |
| Refunds                    | 5xx with `area=refunds`. A refund the provider refuses without throwing is NOT yet an alert (gap)                                 |
| Background jobs            | Worker job failures (all queues), `FINANCE_DISCREPANCY_OPENED`, `NOTIFICATION_FAILED`, `PILOT_AUTO_PAUSED`                        |
| Security                   | `AUTH_REFRESH_TOKEN_REUSE`, `ADMIN_MFA_LOCKOUT`, `ADMIN_ACCESS_CHANGED`, `LOGIN_BACKOFF_BURST` (warning level except token reuse) |

Ops alerts go to Sentry on every occurrence (the email stays throttled), grouped by
`fingerprint = ['ops-alert', kind, key]`, with `alert_kind` and `area` tags. Money-critical
kinds are `error`, the rest `warning` (`apps/api/src/ops/alerts/ops-alert-sentry.bridge.ts`).

## Privacy: what can never be sent

`sendDefaultPii: false`, and `scrubSensitiveData` / `scrubBreadcrumb`
(`apps/api/src/observability/sentry.ts`) run on every event and breadcrumb:

- Request: cookies, body, query string and the `authorization`, `cookie`, `set-cookie` and
  bot-check token headers are removed; secret path segments are redacted; `user` is removed.
- Free text (event message, exception values, breadcrumb messages, every string in `extra`
  and non-runtime `contexts`): emails, UPI addresses, card numbers, phone numbers, OTP-like
  codes, bearer tokens and JWTs are replaced.
- Structured data: any key naming a password, OTP, secret, token, authorization, cookie,
  card, CVV, PAN, Aadhaar, UPI/VPA, phone, mobile, email, account number, IFSC, IBAN,
  signature, API key or private key is replaced whatever its value.
- Kept: ids (cuid, provider references), amounts, statuses, dates.

Proved with the real SDK (10.69.0) and an in-memory transport: an error, a breadcrumb and
extras carrying an email, an Indian phone number, an OTP, a card number (plain and spaced),
a UPI address and a bearer token produced an envelope with none of them, and the booking id
kept. Note: Sentry also ships the SOURCE LINES around each stack frame. Those are our code,
not runtime values, but never put a real secret or test card in source.

## Environments and releases

- Environment: `SENTRY_ENVIRONMENT`, else `APP_ENV` (`qa`, `uat`, `production`), else
  `NODE_ENV`. QA and UAT run `NODE_ENV=production`, so APP_ENV is what keeps them apart.
- Release: `SENTRY_RELEASE`, else `GIT_SHA` (baked into an image built once in CI, see
  docs/deployment/IMAGE-PROMOTION.md), else `RAILWAY_GIT_COMMIT_SHA` (a Railway build).
  A promoted image keeps the release of the commit it was built from, in every environment.
- Source maps: not uploaded anywhere today. The API and worker are compiled by `tsc`; stack
  traces point at `dist/*.js`, which still name the file and function. Uploading maps needs a
  Sentry auth token as a CI secret (owner) and a `sentry-cli sourcemaps upload` step in the
  image build. Planned with the image workflow, not done.

## Alert rules to create in Sentry (owner, in the Sentry UI)

These cannot be created from this repository. Suggested, per project and environment
`production` (QA/UAT: email only):

| Rule             | Condition                                                                                                                                                                                   | Route                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Money path down  | issue with `area` in `checkout`, `payments`, `payments.webhook`, `refunds` and level `error`: first seen, or more than 5 events in 5 min                                                    | page on-call + email |
| Ops alert, money | tag `alert_kind` in `WEBHOOK_SIGNATURE_REJECTED`, `CAPTURE_NOT_APPLIED`, `EXPIRY_FOUND_CAPTURE`, `CONFIRMATION_FAILED_AFTER_PAYMENT`, `WEBHOOK_DEAD_LETTERED`, `FINANCE_DISCREPANCY_OPENED` | page on-call         |
| Security         | tag `alert_kind` in `AUTH_REFRESH_TOKEN_REUSE`, `ADMIN_MFA_LOCKOUT`, `ADMIN_ACCESS_CHANGED`, `LOGIN_BACKOFF_BURST`                                                                          | security email       |
| Regression       | a resolved issue reappears in a new `release`                                                                                                                                               | email                |
| Error spike      | more than 50 events per hour, any `area`                                                                                                                                                    | email                |

## Web apps (not done; needs a decision)

The three Next.js apps have no error reporting at all: client errors show only as toasts.
Options:

1. `@sentry/nextjs` in each app (client, server, edge, `instrumentation.ts`,
   `global-error.tsx`). Standard, gives breadcrumbs and source maps. But its client DSN is
   read from `NEXT_PUBLIC_SENTRY_DSN` at BUILD time, which ties the image to one environment
   (the same problem as `NEXT_PUBLIC_API_URL`, see IMAGE-PROMOTION.md). Initialising the
   client SDK from a runtime config fetched by the page avoids that.
2. A small reporter in `packages/web-kit` that posts scrubbed client errors to an API route,
   which forwards them with the API's Sentry client and scrub. No new dependency in the web
   bundles and one privacy policy, but no breadcrumbs or browser source maps.

Recommendation: option 1 with runtime DSN, done together with the runtime-config work for the
web images. It adds a dependency to the checkout bundle, so it needs its own PR and a browser
check of checkout on QA.

## Mobile

- Android: set `release`/`dist` explicitly from the app version and build number; extend
  `redactSecretKeys` (`packages/shared-types/src/client-security.ts`) with the phone, email,
  UPI/VPA and card keys above (it covers only authorization/token/password/otp/secret/cookie/
  refresh today, which contradicts PLAY-RELEASE.md). Production EAS builds upload maps when
  `SENTRY_AUTH_TOKEN` is an EAS secret.
- iOS: no crash reporting. Needs sentry-cocoa and the same scrub rules.
