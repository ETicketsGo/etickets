# Error monitoring with Sentry (proposal)

**Status:** PROPOSED. `SENTRY_DSN` is **not set** on PROD api or worker (verified 2026-11-12), so production errors are seen only in Railway logs. Turning it on is one variable per service and needs owner approval.

## What already exists in code (no change needed)

- **API and worker** (`apps/api/src/observability/sentry.ts`): `sendDefaultPii: false`.
  - `beforeSend` and `beforeBreadcrumb` scrub keys (otp, phone, email, upi, vpa, card, ifsc, token, password…) and free text (email addresses, VPAs, OTP-like codes, card-like numbers).
  - Tracing is off unless `SENTRY_TRACES_SAMPLE_RATE` is set.
- **Mobile app** (`apps/customer-mobile/src/services/sentry.ts`): `sendDefaultPii: false` plus secret-key redaction.
- **Web apps:** no Sentry (register AR-14). Out of scope here.

## Proposed configuration

| Variable                    | api                  | worker               | Value                                                                                                                                                                                                           |
| --------------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | ✓                    | ✓                    | DSN of a project in an organization created for ETicketsGo. **Choose the data region at org creation; it cannot be changed later.** US region keeps errors with the database; the EU region is the alternative. |
| `SENTRY_ENVIRONMENT`        | already `production` | already `production` | —                                                                                                                                                                                                               |
| `SENTRY_RELEASE`            | commit SHA           | commit SHA           | Optional. Lets an error be tied to a deploy.                                                                                                                                                                    |
| `SENTRY_TRACES_SAMPLE_RATE` | unset (0)            | unset (0)            | Keep tracing off: no request bodies or URLs leave the platform.                                                                                                                                                 |

**In the Sentry project settings:**

1. Turn on **Data Scrubber**, **Use Default Scrubbers** and **Prevent Storing of IP Addresses**.
2. Add the additional sensitive fields: `email, phone, contact, vpa, upi, otp, buyerEmail, buyerName, holderName, holderEmail, attendeePhone, card, account_number, ifsc, pan, gstin`.
3. Set **Data Retention** to 30 days (the shortest that still covers a monthly review).
4. Invite the owner only. Turn on 2FA.

## Verify after enabling (QA first, then PROD)

1. Trigger a handled test error carrying an email and a phone number in its context. On QA, use an admin-only route or the ops test endpoint, if one exists.
2. In Sentry, confirm:
   - the event arrived;
   - the email and phone show as `[Filtered]` or `[redacted]`;
   - there is no IP address;
   - there is no request body.
3. Set an alert rule: new issue in `production`, sent to the owner's email and phone.

## Cost

The Developer plan is free: 5k errors a month, one user. Move to the Team plan ($26/month) only if volume or users require it.

## Sub-processor

Once enabled, Sentry joins the sub-processor list in the privacy notice (`docs/compliance/PRIVACY-NOTICE-UPDATES-2026-11.md`).
