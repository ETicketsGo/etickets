# Owner configuration for the India pilot

Each item below is something only the owner can do: it needs a secret, an account, a DNS change or a
decision. Engineering has made the code ready for every item. **No value appears in this document.**

## Before you change any Railway variable

A variable change on Railway redeploys the service, and an unpinned redeploy builds the **latest main**,
not the release that production runs. This has already upgraded UAT by accident once.

- In the Railway dashboard, make variable changes as **staged changes** and do not deploy them.
- Tell engineering. They deploy the pinned release commit with the new variables, then check it.

Services are named `api`, `worker`, `customer-web`, `organizer-web`, `admin-web` and `db-seed` in each
environment (QA, UAT, PROD).

## 1. Admin MFA (`MFA_ENCRYPTION_KEY`) - required before sales

|             |                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Where       | PROD: `api` **and** `worker` - the **same** value on both                                                         |
| Value       | 32 random bytes, base64: run `openssl rand -base64 32` on your own computer                                       |
| Keep a copy | In your password manager. If the key is lost after anyone enrolls, the API refuses to start until it is restored. |

Steps:

1. Generate the key and set it on PROD `api` and `worker` as staged changes.
2. Engineering deploys `api` and `worker` at the release commit.
3. Sign in to `https://admin.eticketsgo.com`. The console sends you to set up MFA: enter your password
   again, scan the QR code with an authenticator app, type the first code.
4. **Save the 10 recovery codes** offline. Each works once.
5. Sign out and sign in again to confirm the code is asked for.

Until step 1 is done, MFA is off and the API logs one warning at start. Details: `docs/security/ADMIN-MFA.md`.

## 2. Operational alerts (`OPS_ALERT_EMAILS`) - required before sales

|       |                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------- |
| Where | QA and PROD: `api` **and** `worker`                                                                |
| Value | Comma-separated email addresses of the people on call, for example your own and the second admin's |

An email is sent when a payment webhook is refused, money is captured for a booking that cannot take it, a
paid hold reaches its expiry, a finance discrepancy opens, a confirmation fails after payment, or a webhook
or customer message is given up. Admin > Operations shows "Ops alerts: configured" when it is set.
First action for each alert: `docs/ONCALL-RUNBOOK.md`.

## 3. Error tracking (`SENTRY_DSN`) - recommended

|       |                                                                            |
| ----- | -------------------------------------------------------------------------- |
| Where | QA and PROD: `api` and `worker` (the web apps are not wired for Sentry)    |
| Value | The DSN of a Sentry project (sentry.io, free tier is enough for the pilot) |

Personal data is removed before sending (see `apps/api/src/observability/sentry.ts`).

## 4. Microsoft 365 DKIM - required for the support mailbox

Today `eticketsgo.com` has the Microsoft 365 MX record, SPF and DMARC (`p=quarantine`), but **no DKIM**
(`selector1._domainkey` and `selector2._domainkey` do not exist). Mail from the support mailbox can
therefore be quarantined by the domain's own DMARC policy.

1. Microsoft Defender portal > Email & collaboration > Policies > Threat policies > Email authentication
   settings > DKIM > select `eticketsgo.com`.
2. Copy the two CNAME records it shows (`selector1._domainkey` and `selector2._domainkey`).
3. Add both at GoDaddy (DNS for `eticketsgo.com`), wait for them to resolve, then switch DKIM **on** in
   the portal.
4. Send a test mail from the support mailbox to a Gmail address; "Show original" must say `DKIM: PASS`.

Customer emails go through Amazon SES (custom MAIL FROM `mail.eticketsgo.com`, already in DNS) and are not
affected by this step.

## 5. India SMS (DLT templates under DPTRCS) - optional for an email-only pilot

The sender header `DPTRCS` is approved; `ETKTGO` was rejected and the API refuses it. **No template is
approved yet.** The exact texts to register, the category (Service Implicit) and the variable format are
in `docs/notifications/INDIA-DLT-TEMPLATES.md`.

1. Register at least the sign-in code template and the show-cancelled template on the DLT portal under
   DPTRCS, then add them in MSG91.
2. Set the per-template variables listed in section 4 of that document on `api` and `worker`.
3. Test one real code on Jio, Airtel and Vi before advertising phone sign-in.

**For an email-only pilot** set `SMS_ENABLED=false` on `api` (QA and PROD). Sign-in then opens on email;
guest checkout, tickets, cancellations and refunds all go by email.

## 6. Off-site backup copy - required before scaling beyond the pilot

Every backup today lives in the same Railway project as the database.

1. Create an S3 bucket in `ap-south-1` with versioning on and a lifecycle rule for retention (for example
   35 days). Optionally Object Lock.
2. Create an IAM user (or role) allowed only `s3:PutObject` on that bucket.
3. On PROD `db-seed` set `BACKUP_OFFSITE_BUCKET`, `BACKUP_OFFSITE_REGION` and that user's
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (optional: `BACKUP_OFFSITE_PREFIX`,
   `BACKUP_OFFSITE_SSE`, `BACKUP_OFFSITE_KMS_KEY_ID`). A paid AWS resource: your decision.
4. This needs the newer `db-seed` code; see `docs/deployment/RAILWAY_BACKUP_RECOVERY.md` section 12.
   That update also makes backups visible on Admin > Operations.

## 7. Second administrator

Use the existing ADMIN role with all permissions. No new super-admin feature.

1. Name the person. They register themselves at `https://www.eticketsgo.com` with their own email and
   password (an administrator never chooses someone else's password).
2. After MFA is armed (item 1), you open Admin > Staff, find their account, and grant ADMIN with the
   permissions they need. For continuity that is all permissions; review the list with them.
3. On their first sign-in they set up MFA and store their 10 recovery codes.
4. Both administrators keep their recovery codes offline. A lost phone is recovered with a recovery code;
   _Account security_ then replaces the authenticator.
5. SUPER_ADMIN stays with you only. That has two consequences: actions limited to SUPER_ADMIN (for example
   booking compensation, resetting someone else's MFA) remain yours, and **nobody else can reset your MFA**.
   You can reset the second administrator's; if you lose both your phone and your recovery codes, the only
   way back is the break-glass procedure (`docs/security/ADMIN-MFA.md` section 6), which needs engineering
   and database access. Store your recovery codes in two separate safe places.

## 8. Decisions that are yours, not configuration

- **The Rs 519.18 live payment** (`pay_TkVxCS4BmDljlf`, order `order_TkVvx7pyLnoLTR`): your own test,
  captured on 2026-10-06 while every webhook was refused; the booking expired with no ticket. Refund it in
  the Razorpay dashboard, or keep it as recorded test money. Engineering records the outcome after you
  decide. Record: `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`.
- **The three other Razorpay orders** (`order_Ti0ZgG4TUERr8s`, `order_Ti9ywwxLCj7NHY`,
  `order_TiB668NA23wep9`): created, never attempted, no money. Their payment rows can be closed as
  abandoned when you approve.
- **GST**: stays off until the classification work and a professional tax review are complete.
- **Public sales**: stay disabled until you give a separate launch authorization.
