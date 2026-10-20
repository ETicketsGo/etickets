# ADR-054: Confirming the SES event subscription automatically, in every environment

- **Status:** Accepted
- **Date:** 2026-10-20
- **Supersedes:** [ADR-052](./ADR-052-sns-confirmation-capture.md) (manual capture and one-time reveal)
- **Relates to:** [ADR-050](./ADR-050-notification-launch-certification.md) (SNS signature verification)
- **Scope:** `POST /api/notifications/webhooks/ses/:secret`, `SubscriptionConfirmation` only

## Context

The SES webhook never confirmed an SNS subscription itself. ADR-052 held a verified
confirmation in the database so a person could reveal the URL once and open it, but only in
`LOCAL/DEV/TEST/CI/QA/UAT`. In `PRODUCTION` the token was never stored, so production had no
way to confirm its subscription at all. Without a confirmed subscription no bounce or complaint
reaches production, and a hard-bounced buyer keeps being mailed.

The reason for refusing to auto-confirm was sound: a valid signature proves Amazon sent the
message, not that we want the subscription. Anybody with an AWS account can create a topic
and subscribe this URL to it. But the answer to that is the topic allowlist
(`SES_SNS_TOPIC_ARNS`), which an operator already sets deliberately per environment. The
person in the manual flow could only re-check the same fact.

## Decision

On a `SubscriptionConfirmation` the webhook confirms the subscription itself, in every
environment, when ALL of these hold. Otherwise it refuses with the same 401 a forgery gets,
logs a redacted reason, writes nothing and fetches nothing.

1. **Path secret** matches `SES_WEBHOOK_SECRET` (constant-time; unset refuses everything).
2. **Signature** verifies (`SnsVerifier`):
   - `SigningCertURL` is https, has no userinfo or port, has a host matching
     `^sns\.<region>\.amazonaws\.com(\.cn)?$` (anchored; `s3`, lookalike suffixes and trailing
     dots fail), and a path ending `.pem` with no query string.
   - The certificate is fetched with a 5 s timeout and `redirect: 'error'`, size-capped, and
     cached (at most 32 entries).
   - `SignatureVersion` 1 is RSA-SHA1 and 2 is RSA-SHA256. A version that does not match its
     signature algorithm fails; any other version is refused.
   - The type that is acted on is the SIGNED `Type`, not the unsigned
     `x-amz-sns-message-type` header.
3. **Topic**: `TopicArn` is in `SES_SNS_TOPIC_ARNS`, matched exactly. An unset or blank list
   refuses every confirmation (delivery events still tolerate it, as before).
4. **SubscribeURL** (`validateSubscribeUrl`):
   - https, no userinfo or port.
   - Host exactly `sns.<region>.<partition suffix>`, built from the TopicArn's region and
     partition (it is not matched against a pattern).
   - Path `/`, no fragment.
   - Query exactly `Action`, `TopicArn` and `Token`, each once: `Action=ConfirmSubscription`,
     and `TopicArn` and `Token` equal to the message's signed fields.

Then exactly **one GET** to that validated URL, with `redirect: 'manual'` (a 3xx is a failure
and its Location is never requested) and a 5 s timeout. The reply must be a
`ConfirmSubscriptionResponse` whose `SubscriptionArn` belongs to that topic. No other URL is
ever fetched by this flow.

**Idempotency and record.** `SnsPendingConfirmation` gains additive columns: `tokenHash`
(SHA-256), `confirmedAt`, `subscriptionArn`, `lastAttemptAt`, `lastFailure` and `attemptCount`,
with a unique index on `(topicArn, tokenHash)`.

- A confirmation already `CONFIRMED` for the same topic and token is a no-op. A replay
  therefore cannot re-subscribe an endpoint that was since unsubscribed.
- A lease (`lastAttemptAt`, 30 s) stops two concurrent deliveries both calling Amazon.
- A failed call leaves the row `PENDING` with a redacted `lastFailure` and answers **502**, so
  SNS redelivers.
- A success sets `CONFIRMED`, marks older `PENDING` rows for the topic `EXPIRED`, and writes the
  audit entry `SNS_SUBSCRIPTION_CONFIRMED`. A failure writes `SNS_SUBSCRIPTION_CONFIRM_FAILED`.

**Nothing secret at rest or in logs.** The token is used in the same request it arrives in.
The row stores its hash and the URL with `Token=NOT-STORED`. Logs and audit metadata carry the
topic and a reason, never the URL, the token or the SubscriptionArn (the SubscriptionArn is
also the key to an unauthenticated unsubscribe).

**`UnsubscribeConfirmation`** is logged and acknowledged, never acted on.

**The behaviour does not depend on `APP_ENV`.** Production is not a special case with its own
untested path; each environment differs only by the topic it names.

## Retired

- The capture path, the one-time reveal (`POST .../sns/pending-confirmation/reveal`), the
  operator's "mark confirmed" (`POST .../sns/pending-confirmation/:id/confirmed`) and the
  `APP_ENV` capture guard. Automatic confirmation works everywhere, so they added nothing
  except a plaintext token in a database row.
- `GET /api/admin/notifications/sns/pending-confirmation` (`PLATFORM_CONFIG`) stays. It now
  returns the latest record: status, attempts and the last failure reason.
- No columns were dropped. Rows written by the retired flow keep their original
  `subscribeUrl`. Those tokens expired 72 hours after they arrived.

## Consequences

- The production procedure is: set `SES_WEBHOOK_SECRET` and `SES_SNS_TOPIC_ARNS` on the api,
  deploy, then create the HTTPS subscription. The console shows **Confirmed** within seconds.
  A subscription created before the variables were set stays pending. Use **Request
  confirmation** in the SNS console after setting them.
- The api needs outbound HTTPS to `sns.<region>.amazonaws.com`. It already needs it for the
  signing certificate.
- Tests: `sns-subscribe-url.spec.ts`, `sns-verifier.spec.ts` (certificate URL and SigV1/V2
  cases), `sns-confirmation.spec.ts` (each rule, in PRODUCTION and QA),
  `sns-confirmation.integration-postgres.spec.ts` (idempotency and the race), and
  `sns-auto-confirm.http.integration-postgres.spec.ts` (whole AppModule over HTTP, LOCAL and
  PRODUCTION).
