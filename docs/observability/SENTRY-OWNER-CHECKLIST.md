# Sentry: what the owner must provide (2026-11-06)

Code is ready for the API and worker (#588). Nothing reports until the items below exist. No
DSN, token or credential has been created or guessed by an engineer or by Claude. Each of these
is an account action in Sentry, GitHub, Railway or EAS.

## 1. Sentry projects (Sentry UI, organization owner)

| Project (suggested name)   | Platform     | Who reads its DSN                                                                     |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `eticketsgo-api`           | Node         | Railway `api` service                                                                 |
| `eticketsgo-worker`        | Node         | Railway `worker` service (or reuse the api project; the `service` tag separates them) |
| `eticketsgo-customer-web`  | Next.js      | Not wired yet (AR-14); runtime DSN via #592's runtime config                          |
| `eticketsgo-organizer-web` | Next.js      | Not wired yet (AR-14)                                                                 |
| `eticketsgo-admin-web`     | Next.js      | Not wired yet (AR-14)                                                                 |
| `eticketsgo-mobile`        | React Native | EAS build (Android today; iOS needs sentry-cocoa, AR-15)                              |

Set **Data scrubbing ON** and **Store native crash reports OFF** for each. Turn on IP address
scrubbing: the SDK scrub already removes it, and this is a second layer.

## 2. Variables per environment (Railway, per service)

| Variable                    | api      | worker   | Value                                                                 |
| --------------------------- | -------- | -------- | --------------------------------------------------------------------- |
| `SENTRY_DSN`                | yes      | yes      | from the project. A DSN is not a secret, but keep it per environment. |
| `SENTRY_ENVIRONMENT`        | optional | optional | defaults to `APP_ENV` (`qa`, `uat`, `production`)                     |
| `SENTRY_RELEASE`            | no       | no       | derived: `GIT_SHA` (image built once) or `RAILWAY_GIT_COMMIT_SHA`     |
| `SENTRY_TRACES_SAMPLE_RATE` | optional | optional | `0` to start, `0.05` later for production                             |

Order: QA first. **A variable change deploys `main`** on Railway: use `skipDeploys: true`, then
redeploy the current deployment (the deploy kit's procedure).

## 3. Source maps (GitHub, repository secrets)

| Secret                                        | Scope                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`                           | Sentry "internal integration" token with **Release: Admin** and **Project: Read** only, nothing else |
| `SENTRY_ORG`                                  | organization slug (a variable, not secret)                                                           |
| `SENTRY_PROJECT_API`, `SENTRY_PROJECT_WORKER` | project slugs (variables)                                                                            |

Then add a `sentry-cli sourcemaps inject` + `upload` step to `build-images.yml` (not done:
it needs the token to test, AR-16). Mobile: `SENTRY_AUTH_TOKEN` as an **EAS secret** for
production builds; `SENTRY_DISABLE_AUTO_UPLOAD` stays `true` for QA builds.

## 4. Alert rules (Sentry UI)

The five rules in `docs/observability/SENTRY.md` (money path, ops alerts, security, regression,
error spike), production paging to on-call, QA/UAT email only. They key on the tags #588 sets:
`area`, `alert_kind`, `service`, `status`, `provider`.

## 5. Verify after setting (QA)

Status 2026-11-06: **blocked**. No service in QA, UAT or PROD has `SENTRY_DSN` (variable
names read from Railway), so no event can be received anywhere. Monitoring is not
operational until these three checks pass on QA.

1. Boot: the new api and worker deployments log `Sentry initialised (error tracking
enabled).` A missing line means the DSN did not reach that service.
2. Handled failure, using a route that already exists (no test route needed): send a webhook
   with a wrong signature to QA,
   `curl -X POST https://api-qa.eticketsgo.com/api/payments/webhooks/razorpay -H 'content-type: application/json' -H 'x-razorpay-signature: 00' -d '{"event":"sentry.verification"}'`.
   The API refuses it (4xx) and raises the `WEBHOOK_SIGNATURE_REJECTED` ops alert. Expect one
   issue in `eticketsgo-api`, environment `qa`, message `[ops] WEBHOOK_SIGNATURE_REJECTED`,
   tags `alert_kind=WEBHOOK_SIGNATURE_REJECTED`, `area=payments.webhook`, level `error`.
3. Privacy: search the QA project for the test account's email address and phone number: zero
   results.

An unhandled 5xx (`captureException` in `AllExceptionsFilter`) is checked by the first real
one; do not add a crash route to the API for it.
