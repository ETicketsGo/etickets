# Real-email certification (India pilot)

Prepared 2026-10-12 from `origin/main 3ef1b51d`. Purpose: the requirements, checks and pass criteria for
certifying that ETicketsGo email reaches real inboxes from PRODUCTION, so buyers and organizers get their tickets,
refunds and password resets. Email is the only buyer channel in the pilot (SMS, WhatsApp and push are in log mode;
`INDIA-COMMUNICATIONS.md`). Production stays NO-GO; this document does not change that verdict. It builds on
`INDIA-COMMUNICATIONS.md`, `PILOT-READINESS.md` (owner actions 6 and 8, GO criterion 4),
`docs/guides/SES-NEW-ACCOUNT-CUTOVER.md` and `docs/notifications/PROVIDER-SETUP.md`.

## 1. Verdict

1. **Production email is UNPROVEN and cannot be proven from engineering's side alone.** Nothing here was run on
   production. No real message from production has reached a real mailbox (`PILOT-READINESS.md` GO criterion 4).
2. **The code path works.** On QA today the readiness report reads email for India as `ses`, `READY`, delivery
   callbacks `OBSERVED`, and the certification report reads `LIVE_CERTIFIED` / `PASS` (section 2). That proves the
   chain enqueue, worker, SES, SNS, webhook on QA. It does not prove production DNS, production SES access, or
   inbox placement.
3. **One step cannot be done in production as built:** confirming the SNS subscription. The confirmation token is
   deliberately never stored or logged in production, so the "confirm in the console" step has no token to use
   (section 6.1). Decide the route before launch day; this is the one engineering-and-owner decision on the critical
   path.
4. **The "organizer invite" email does not exist.** Team invitations are a link the owner copies and sends
   (section 8, row 4). Certify the link, not an email.
5. **The booking confirmation email carries no QR code.** For a guest it carries the booking reference and a link
   to the tickets; for a signed-in buyer it carries the reference only and the buyer signs in (section 8, row 1).
   Pass criteria are written for what the message actually contains.

6. **`BOOKING_CANCELLED` is never sent.** The template and policy exist, but no code path creates the message, so a
   buyer who cancels a free or unpaid booking gets no email (`refunds.service.ts:379-383`; a search of
   `apps/api/src` finds no producer). `INDIA-COMMUNICATIONS.md` section 2 lists it as delivered; it is not.
   `SHOW_CANCELLED` and `REFUND_COMPLETED` are sent.

Evidence labels: **[code]** read at `3ef1b51d`; **[QA 2026-10-12]** a read-only call as `admin@eticketsgo.test`
(names and counts only; no recipient address, secret or token was read or recorded); **[doc]** another document,
not re-verified; **[memory]** an owner note, a lead and not a fact.

## 2. What QA shows today (read-only, 2026-10-12)

| Check                                 | Call                                                              | Result                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email provider and state, India       | `GET /api/admin/notifications/readiness/configuration`            | IN email: `provider: ses`, `configState: READY`, `webhookState: OBSERVED`, `rateState: CONFIGURED`, `externalCertificationState: BLOCKED_EXTERNAL_CERTIFICATION`, no missing keys                                                                   |
| Same, SMS / WhatsApp / push for India | same                                                              | `provider: log`, `configState: DISABLED` for all three (nothing sent)                                                                                                                                                                               |
| Certification level, India            | `GET /api/admin/notifications/readiness/certification?markets=IN` | email `LIVE_CERTIFIED`, outcome `PASS`, "Accepted by the provider and confirmed by a callback"; `lastTestSendAt` 2026-09-10, `lastProviderAcceptedAt` 2026-10-12, `lastCallbackAt` 2026-10-12; market level `CODE_READY` because SMS is in log mode |
| Recorded certifications               | `GET /api/admin/notifications/readiness/certifications`           | empty list: nobody has recorded a certification (that is a `PLATFORM_CONFIG` act, section 12 row 14)                                                                                                                                                |
| Platform flags                        | `GET /api/admin/notifications/readiness?markets=IN`               | `messageContentLogged: false`, `callbacksAwaitingCorrelation: 0`, `remindersEnabled: false`, `whatsappOptInEnforced: false`                                                                                                                         |
| Provider outcomes, last 24 hours      | `GET /api/admin/notifications/health`                             | `ses` email: 27 ACCEPTED, 2 UNDELIVERED (29 total); `log` push 28; `in_app` 29; `whatsapp` 5 REJECTED, none delivered                                                                                                                               |
| Suppression list                      | `GET /api/admin/notifications/suppressions`                       | 4 entries, channel email, provider ses, reasons 2 `HARD_BOUNCE` and 2 `COMPLAINT` (masked destinations). This is the bounce and complaint path working                                                                                              |
| Recent email rows (latest 100)        | `GET /api/admin/notifications?channel=email&limit=100`            | 99 to a `eticketsgo.test` address and 1 to a real mailbox domain. Delivery states: 72 UNDELIVERED, 27 ACCEPTED, 1 DELIVERED (the one to the real mailbox)                                                                                           |
| Platform backup field                 | `GET /api/admin/ops/health`                                       | `appEnv: QA`, `backup.status: never` (no verified backup ever recorded on QA)                                                                                                                                                                       |

What these mean:

- **The SES -> SNS -> webhook chain delivers events on QA** (`webhookState: OBSERVED`; a real `DELIVERED` row;
  hard-bounce and complaint suppressions). The 2026-09-10 owner note reports the same three paths were proven on the
  previous AWS account [memory: `ses-sns-webhook`]; this is fresh evidence on the current account.
- **QA's AWS account accepts mail to addresses it cannot have verified.** 99 of the last 100 rows went to
  `eticketsgo.test`, a domain that cannot receive a verification message, and SES accepted them. A sandboxed SES
  account refuses unverified recipients at the API call. **Inference, not proof:** the QA account has production
  access. The previous account was in the sandbox with a DENIED request [memory 2026-09-10]. The owner confirms
  with `aws sesv2 get-account` (field `ProductionAccessEnabled`) for the account PRODUCTION will use (section 4,
  row S1). Production may use a different account from QA.
- **QA synthetic mail bounces.** 72 of 100 QA rows ended UNDELIVERED (a non-permanent bounce, per
  `sesBounceState`, `packages/shared-types/src/notification-provider-status.ts:136`). These are not suppressed, so
  they are retried on later sends. If QA and production share an AWS account or a sending domain, QA test traffic to
  `.test` addresses counts against the same reputation. Engineering item E2 (section 12). Do not run bulk QA
  tests against real domains.
- **Test sends are limited.** `POST /api/admin/notifications/readiness/test-send` (`PLATFORM_CONFIG`) sends one
  `PASSWORD_CHANGED` email to an address you name (`notification-readiness.controller.ts:164-215`) [code]. It proves
  SES access and DNS for one message type. It does not prove the booking, refund or reset templates, so it is a
  smoke test, never the certification.

## 3. Requirements to certify live email

All must hold on the PRODUCTION environment. The owner/engineering split is section 12.

| #   | Requirement                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | An SES account for production **out of the sandbox** (production access enabled), sending enabled, healthy enforcement status                                                                                                          |
| R2  | A verified **domain identity** for the sending domain, with Easy DKIM verified                                                                                                                                                         |
| R3  | **SPF** aligned (custom MAIL FROM recommended), **DKIM** passing, **DMARC** published                                                                                                                                                  |
| R4  | A **configuration set** named in `SES_CONFIGURATION_SET`, with an SNS event destination for Delivery, Bounce, Complaint and Reject (not Open or Click)                                                                                 |
| R5  | An **SNS topic** in the same region, with an **HTTPS subscription confirmed** to `https://<api-host>/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>`, raw message delivery OFF                                                    |
| R6  | Production variables set on **both api and worker**: `EMAIL_PROVIDER=ses`, `EMAIL_FROM`, `AWS_REGION`, credentials from the production IAM principal, `SES_CONFIGURATION_SET`, `SES_WEBHOOK_SECRET`, `SES_SNS_TOPIC_ARNS` (names only) |
| R7  | `CUSTOMER_WEB_URL`, `ORGANIZER_WEB_URL`, `ADMIN_WEB_URL`, `PUBLIC_API_URL` are the **production** origins, https                                                                                                                       |
| R8  | `ALLOW_UNDELIVERABLE_NOTIFICATIONS` unset after the first real email, so the boot guard that refuses `EMAIL_PROVIDER=log` is back on; `SMS_ENABLED=false`                                                                              |
| R9  | Every message in the matrix (section 8) received, opened and checked in every mailbox (section 9), with no failure                                                                                                                     |
| R10 | Bounce and complaint events change state in production (a simulator bounce and a simulator complaint suppress the address)                                                                                                             |
| R11 | The production IAM principal is its own (`eticketsgo-prod-runtime`); the QA SES user is not used on production (`INFRASTRUCTURE.md` section 1.4)                                                                                       |

## 4. SES production access and identity (owner)

| #   | Step                                    | How to check (names only, never paste a key)                                                                                                                                                                                                                                     | PASS                                                                                                                                   |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Production access                       | `aws sesv2 get-account --region <region>`: read `ProductionAccessEnabled`, `SendingEnabled`, `EnforcementStatus`, `Details.ReviewDetails.Status`, `SendQuota`                                                                                                                    | `true`, `true`, `HEALTHY`, not `DENIED`, quota well above pilot volume                                                                 |
| S2  | Domain identity                         | `aws sesv2 get-email-identity --email-identity <domain> --region <region>`: `VerifiedForSendingStatus`, `DkimAttributes.Status`, `MailFromAttributes.MailFromDomainStatus`                                                                                                       | `true`, `SUCCESS`, `SUCCESS`                                                                                                           |
| S3  | Configuration set and event destination | `aws sesv2 get-configuration-set-event-destinations --configuration-set-name <name>`                                                                                                                                                                                             | enabled; event types exactly Delivery, Bounce, Complaint, Reject (add Send if wanted); SNS topic in the same region; no Open, no Click |
| S4  | Region consistency                      | The SES identity, configuration set and SNS topic are all in the region `AWS_REGION` names                                                                                                                                                                                       | Same region everywhere                                                                                                                 |
| S5  | If production access is DENIED          | Do not resubmit the same wording (`SES-NEW-ACCOUNT-CUTOVER.md` Step 3): transactional only, how recipients opted in (they bought a ticket), how bounces and complaints are handled (signature-verified webhook that suppresses the address), honest pilot volume, a sample email | A new request with different content                                                                                                   |

Allow a day or two for review [doc]. AWS decides; nothing in the repository shortens it. Until S1 passes, every send
to a normal buyer address is refused and the certification is BLOCKED, never PASS.

## 5. DKIM, SPF and DMARC records (owner publishes, engineering verifies)

Records for domain `D` (the sending domain, for example the one in `EMAIL_FROM`). Values come from the SES identity
page; compare what DNS answers with what SES shows. Run from any machine with `dig`, or on Windows with `nslookup`.
Check with at least two public resolvers (`8.8.8.8`, `1.1.1.1`) and the domain's own name servers, because a
record that one resolver has not yet seen is the commonest false failure.

| Record                                         | Name and type                 | What it must hold                                                                                                                                     | Check (dig / nslookup)                                                                                                       |
| ---------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| DKIM (three records)                           | `<token>._domainkey.D`, CNAME | `<token>.dkim.amazonses.com` for each of the three tokens shown by SES                                                                                | `dig +short CNAME <token>._domainkey.D @8.8.8.8` / `nslookup -type=CNAME <token>._domainkey.D 8.8.8.8`                       |
| Custom MAIL FROM, MX                           | `mail.D`, MX                  | `10 feedback-smtp.<region>.amazonses.com`                                                                                                             | `dig +short MX mail.D` / `nslookup -type=MX mail.D 8.8.8.8`                                                                  |
| Custom MAIL FROM, SPF                          | `mail.D`, TXT                 | `v=spf1 include:amazonses.com ~all`                                                                                                                   | `dig +short TXT mail.D` / `nslookup -type=TXT mail.D 8.8.8.8`                                                                |
| DMARC                                          | `_dmarc.D`, TXT               | At least `v=DMARC1; p=none; rua=mailto:<mailbox someone reads>`; tighten to `quarantine` once reports are clean (`SES-NEW-ACCOUNT-CUTOVER.md` Step 2) | `dig +short TXT _dmarc.D` / `nslookup -type=TXT _dmarc.D 8.8.8.8`                                                            |
| Root SPF (only if other mail is sent from `D`) | `D`, TXT                      | One SPF record only; two `v=spf1` records invalidate both                                                                                             | `dig +short TXT D`: count the `v=spf1` lines (must be 1 or 0)                                                                |
| Old-account leftovers                          | the old three DKIM CNAMEs     | Deleted when the account changed (`SES-NEW-ACCOUNT-CUTOVER.md` Step 2)                                                                                | The DKIM names in DNS match the CURRENT identity's three tokens, and no extra `_domainkey` CNAME points to a blocked account |

The MX and SPF values above are the standard SES custom-MAIL-FROM values; read the exact strings from the SES
identity page and do not trust this table over it. I could not query production DNS or any AWS account; these are
the checks to run, not results.

**Header proof (the real test).** DNS records can all look right and mail can still fail authentication. In each
mailbox of section 9, open the message source or "Show original" and record the authentication results:

- SPF: `pass`, and the domain it passed for (the MAIL FROM domain);
- DKIM: `pass`, `d=` equal to the sending domain (not `amazonses.com`);
- DMARC: `pass`.

Gmail shows these on "Show original". Outlook.com and Yahoo show them in the raw headers
(`Authentication-Results`). Record "not shown" for a provider that does not expose them, and rely on its placement
instead. **FAIL** if any of the three is `fail` or `neutral`.

## 6. SNS bounce and complaint subscription

**Endpoint** (`POST /api/notifications/webhooks/ses/:secret`) [code: `delivery-webhook.controller.ts:154`]:

1. The path secret must equal `SES_WEBHOOK_SECRET` (checked first, in constant time). An unset secret rejects
   everything, confirmation included.
2. The SNS signature is verified against Amazon's certificate. The signature, not the path, is the authority, because
   a forged bounce suppresses a real buyer's address (`delivery-webhook.service.ts:222-250`).
3. **Express 5 and `text/plain`.** SNS posts a JSON document with `Content-Type: text/plain`. Express 5 leaves such a
   body unparsed, so before PR #90 every real message returned 500. A route-scoped parser now reads it
   (`sns-body.middleware.ts`, bound only to this route). **Do not widen it to other routes**, and do not put a proxy,
   WAF or CDN rule in front that rewrites or rejects `text/plain` on this path [code].
4. A `SubscriptionConfirmation` is never auto-confirmed. The handler verifies the signature, logs the HOST only, and
   (outside production) stores the confirmation URL once (`delivery-webhook.service.ts:253-289`).

**Checks, in order:**

| #   | Check                                                                   | How                                                                                                                                                               | PASS                    |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| N1  | Subscription exists and is not "Pending confirmation"                   | `aws sns list-subscriptions-by-topic --topic-arn <arn>`: protocol `https`, `SubscriptionArn` is an ARN, not `PendingConfirmation`                                 | Confirmed               |
| N2  | Raw message delivery is OFF                                             | `aws sns get-subscription-attributes --subscription-arn <arn>`: `RawMessageDelivery`                                                                              | `false`                 |
| N3  | The endpoint refuses a wrong secret and an unsigned body                | Engineering probe: POST a non-signed body to the real path with the real secret and expect 401, not 500 (a 500 is the text/plain defect); a wrong secret also 401 | 401 both times          |
| N4  | A real `Delivery` event is applied                                      | After a real send: `GET /api/admin/notifications/<id>` shows the delivery state `DELIVERED`                                                                       | `DELIVERED`             |
| N5  | A simulator hard bounce suppresses the address                          | Enqueue a message to `bounce@simulator.amazonses.com` through the normal path; then `GET /api/admin/notifications/suppressions`                                   | New `HARD_BOUNCE` entry |
| N6  | A simulator complaint suppresses the address                            | Same with `complaint@simulator.amazonses.com`                                                                                                                     | New `COMPLAINT` entry   |
| N7  | No log line contains the webhook secret                                 | Search the api logs for the secret; the path must read `[REDACTED]` (PR #92)                                                                                      | No match                |
| N8  | `callbacksAwaitingCorrelation` is 0 and `webhookState` reads `OBSERVED` | `GET /api/admin/notifications/readiness/configuration` and `.../readiness?markets=IN`                                                                             | `OBSERVED`, 0           |

Read delivery status from `NotificationDelivery` (the row's `deliveryState` in the ops list), not the notification's
`status`: a successful send leaves `Notification.status = SENT` and only the delivery row becomes `DELIVERED`
[memory: `ses-sns-webhook`].

### 6.1 The production confirmation gap (decision needed)

The confirmation token arrives once, inside the SNS message body. In production the handler stores nothing and logs
only the host: the capture guard allows `LOCAL, DEV, TEST, CI, QA, UAT` and names `PRODUCTION`, `PROD`, `STAGING` as
never capturing (`sns-confirmation.guard.ts:25-31`), and the reveal route is "Refused in production"
(`notification-ops.controller.ts:142-151`). ADR-052 says "If this is ever wanted in production, the encryption
question has to be answered first -- not this guard relaxed." `SES-NEW-ACCOUNT-CUTOVER.md` Step 6 already flags it:
"Someone has to choose: extend the allowlist to production, add an encrypted reveal, or confirm production by another
route." `docs/notifications/PROVIDER-SETUP.md` step 8 ("Confirm the subscription in the console") does not.

So as built there is no supported way to confirm production's subscription, and without it no bounce or complaint ever
reaches production (R10 fails, and a hard-bounced buyer keeps being mailed, which damages the sending reputation).
Options for the owner to decide (engineering implements the one chosen; none was built or tested here):

| Option                                                                                                        | Effect                                               | Risk                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A. Encrypted, one-time reveal in production for `PLATFORM_CONFIG`                                             | Matches the ADR's own condition; token never in logs | Needs the encryption design the ADR calls for; a code change and a production deploy                  |
| B. Temporary capture window on production, off by default                                                     | Smallest change                                      | Relaxes a deliberate guard; the token sits in the database unencrypted for up to 72 hours             |
| C. Confirm out of band, for example a short-lived endpoint the owner controls that can read the first message | No product change                                    | The owner runs an extra internet-facing endpoint; the SNS message crosses it; must be torn down after |

The "rehearse on QA" step is possible today with the existing QA flow (`GET .../sns/pending-confirmation`,
`POST .../reveal`, `POST .../:id/confirmed`).

## 7. Configuration to confirm on production (names only)

Read by the owner or engineering with the owner present. Do not paste values. `INFRASTRUCTURE.md` section 1.4 and
`PILOT-READINESS.md` owner actions 2 and 8 are the source of truth for the secret-store variables.

| Variable                                                                   | Expectation                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                                                           | `ses` (never `log`: the boot guard refuses it unless the escape hatch is set, `configuration.ts:947-956`)                                   |
| `EMAIL_FROM`                                                               | An address on the verified domain; the IAM policy may condition on `ses:FromAddress`, so they must match                                    |
| `AWS_REGION`                                                               | The SES region (not `AWS_SES_REGION`, which nothing reads)                                                                                  |
| `SES_CONFIGURATION_SET`                                                    | Set. If unset the mail goes out, the row says accepted and no callback ever arrives                                                         |
| `SES_WEBHOOK_SECRET`, `SES_SNS_TOPIC_ARNS`                                 | Set and equal to the subscription URL's secret and the topic ARN                                                                            |
| `CUSTOMER_WEB_URL`, `ORGANIZER_WEB_URL`, `ADMIN_WEB_URL`, `PUBLIC_API_URL` | Production https origins. A link in a message whose host is not one of these is dropped and the message still goes (`link-safety.ts:32-38`) |
| `SMS_ENABLED`                                                              | `false`                                                                                                                                     |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS`                                        | Unset or `false` after the first real email (it also disables the email guard)                                                              |
| Both services                                                              | api AND worker hold the email variables: only the worker sends, so configuring the API alone leaves readiness green while no email leaves   |

Setting a Railway variable redeploys the latest `main` immediately (`variable-change-deploys-main` note). Set the
group together, with the owner's approval, as part of the approved production deploy, never as an experiment.

## 8. The emails to receive and check

Send each one through the NORMAL path (a real action in the product that enqueues the message; the worker sends it).
A direct SES call proves nothing about the platform. Use accounts and mailboxes the team controls. Free and
zero-money actions are preferred; the two money steps reuse the owner's smallest live purchase from
`RAZORPAY-READINESS.md` S6 and S8 (do not buy extra tickets for email testing).

| #   | Message (notification type)                                                          | How to trigger on production                                                                                                                                                       | What the message holds [code]                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Booking confirmation with ticket** (`BOOKING_CONFIRMED`)                           | A free booking on a free test event (no money), then the paid S6 purchase. Do it once as a signed-in buyer and once as a guest                                                     | Subject "Your tickets for <event>"; count, event, time in the VENUE's zone, seats, booking reference. **No QR image and no attachment.** A guest gets a link to the tickets in the body; a signed-in buyer gets no link and signs in (`payments.service.ts:972-998`; `notification-template.service.ts:207-232`). Every message is HTML with a text part                                  |
| 2   | **Guest link** (`GUEST_BOOKING_ACCESS`)                                              | On the guest "find my booking" page enter the reference and email                                                                                                                  | Subject "Your ETicketsGo tickets"; the link only. Each new link invalidates the previous one (`notification-template.service.ts:241-248`)                                                                                                                                                                                                                                                 |
| 3   | **Password reset** (`PASSWORD_RESET_REQUESTED`) and **changed** (`PASSWORD_CHANGED`) | "Forgot password" on a test customer account, then complete the reset                                                                                                              | Link in the BODY only (not in the subject); "works once", expiry minutes; the link host is the production customer or organizer site (`auth.service.ts:382`)                                                                                                                                                                                                                              |
| 4   | **Organizer invite**                                                                 | **There is no invite email.** `inviteMember` returns a link for the owner to copy (`organizations.service.ts:540-609`); staff invites work the same way                            | Certify the link: it opens on the production ORGANIZER (or admin for staff) host, is single-use and expires in 7 days. The related emails that DO exist: `ORGANIZATION_REGISTERED` (to admins), `ORGANIZATION_APPROVED` / `REJECTED`, `EVENT_SUBMITTED`, `EVENT_APPROVED`, `PAYOUT_ACCOUNT_UPDATED` (to owners)                                                                           |
| 5   | **Refund** (`REFUND_COMPLETED`)                                                      | A partial refund of the paid S6 purchase (S8)                                                                                                                                      | "A refund of <amount> for booking <reference> has been completed. It usually reaches your account within a few working days." Check the amount is INR and equals the refund                                                                                                                                                                                                               |
| 6   | **Cancellation** (`SHOW_CANCELLED`; `BOOKING_CANCELLED` is never sent)               | Have the organizer owner cancel a free test show that holds a booking (the cancellation sweep writes `SHOW_CANCELLED` for each booking, `show-cancellation-fanout.service.ts:155`) | `SHOW_CANCELLED`: names the event, says the booking is no longer valid, "A refund will follow." **`BOOKING_CANCELLED` has a template but no code path sends it**: a buyer who cancels their own unpaid or free booking gets no email (`refunds.service.ts:379-383` says so). Record it as NOT SENT BY DESIGN, not as a failure; tell buyers the on-screen confirmation is the only notice |
| 7   | **Check-in notice** (`TICKET_CHECKED_IN`)                                            | Scan the free test ticket at the gate screen                                                                                                                                       | Goes to the ticket holder                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | **Payment failed** (`PAYMENT_FAILED`)                                                | A declined test card is not possible in live mode; skip unless a safe failure exists                                                                                               | Mark BLOCKED, not PASS, if not exercised                                                                                                                                                                                                                                                                                                                                                  |
| 9   | **Bounce and complaint path**                                                        | Section 6, N5 and N6, using simulator addresses                                                                                                                                    | Suppression entries                                                                                                                                                                                                                                                                                                                                                                       |

`EVENT_REMINDER` has no email channel by design and reaches nobody in an email-only pilot (`INDIA-COMMUNICATIONS.md`
section 2). Do not test it as an email.

Locale: the catalogue holds English and French (Canada) only (`packages/i18n/src/messages`). Indian buyers receive
English. Do not promise Hindi, Telugu or other Indian-language mail.

## 9. Mailbox matrix, placement and rendering

Create or borrow one real mailbox in each row. Send all of section 8 (rows 1, 2, 3, 5 and 6 at least) to every
mailbox, from the production environment. Record, per message: arrival time, folder, tab, authentication result,
rendering result, link result.

| Mailbox                                                                                                                                           | Why it is in the matrix                                                   | Check especially                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Gmail (personal) and a Google Workspace inbox                                                                                                     | Largest share; strictest on authentication                                | Inbox vs Spam vs Promotions tab; "Show original" SPF, DKIM, DMARC; no "via amazonses.com" in the sender line if MAIL FROM is custom |
| Outlook.com / Microsoft 365                                                                                                                       | Different filter; Outlook desktop renders HTML with Word                  | Inbox vs Junk; layout in the desktop client; headers                                                                                |
| Yahoo Mail                                                                                                                                        | Publishes sender requirements alongside Gmail                             | Inbox vs Spam; authentication result                                                                                                |
| An Indian-hosted provider, for example Rediffmail (or another India mailbox such as an ISP or Zoho Mail if a Rediffmail account cannot be opened) | The pilot's buyers are in India; some Indian providers filter differently | Inbox vs Spam; delay; whether links are rewritten or stripped; record the provider and the date                                     |
| A company mailbox on a custom domain                                                                                                              | Organizers and staff use these                                            | Whether the mail is quarantined by a gateway                                                                                        |

**Placement rules.** Spam or Junk placement is a FAIL for rows 1, 2, 3 and 5 until fixed (check authentication
first, then content, then sender reputation). "Promotions" or "Other" tab is a WARN, not a FAIL, but is recorded: a
ticket buried in Promotions is a support call. Re-send after any DNS or SES change.

**Rendering.** The layout is tables and inline styles, no remote images and no logo image, so there is nothing for a
client to block (`email-html.ts` header). Check in each mailbox, on desktop and on a phone (390px wide) and in dark
mode where the client has one:

- the heading, the facts panel and the button render; text is readable; no raw `{placeholder}` or `undefined`;
- the time is in India time for a venue in India (the template uses the venue's zone), and the date matches the
  event page;
- the rupee amount reads correctly (no `Rs.` or encoding damage); text-only view also reads sensibly (a text part
  is always sent, `email.transport.ts:126-132`);
- the subject has no secret (password reset and guest link carry the link in the body only);
- no tracking pixel or open/click tracking (configuration-set event types exclude Open and Click).

## 10. Links, unsubscribe and consent

**Link targets.** Click every link in every message. Each must open on a PRODUCTION host (customer, organizer or admin
site as appropriate), over https, to the right page, and must not point to `localhost`, QA, UAT or an API host
(`ORGANIZER_WEB_URL`, `CUSTOMER_WEB_URL` and the others drive them; `console-urls.ts`; a link on a non-configured origin
is removed by `link-safety.ts`, so a MISSING link is also a failure sign). Check the guest link opens the booking, the
reset link opens the reset form once and fails on reuse, and the invite link (row 4) opens the organizer site.

**Unsubscribe.** Every message the platform sends today is TRANSACTIONAL: no marketing type exists, and the mapping
fails to compile if a type is unclassified (`message-class.ts`). The SES send sets no `List-Unsubscribe` header
(`email.transport.ts:117-140`) [code]. A transactional ticket or reset must not be suppressible by a marketing
preference, so no unsubscribe link is expected. Mailbox providers publish extra rules for bulk senders (including
one-click unsubscribe) above a daily volume far higher than the pilot's; confirm the current thresholds in each
provider's sender guidelines [not re-verified]. **PASS** if the footer states why the mail arrived
(`emails.layout.whyTransactional`) and no promotional content is present. **FAIL** if any message contains
promotional text. If a marketing message is ever added, it needs a recorded consent and a working unsubscribe first
(`MarketingConsent`, `INDIA-COMMUNICATIONS.md` section 7).

**Consent.** Email for the pilot rests on the transaction: the buyer gave the address to buy a ticket. The sign-up SMS
consent tick does not apply (no SMS). The privacy policy is a draft (LEGAL REVIEW; see `PILOT-PLAYBOOK.md` section 8).

## 11. PASS criteria

Certification is **PASS** only when ALL are true, with evidence filed:

1. R1 to R11 hold, each with its check output (section 3 to 7).
2. Every row of section 8 that can be triggered was received in EVERY mailbox of section 9, in the inbox (not Spam or
   Junk), within 5 minutes of the action. A row that could not be triggered is **BLOCKED** and listed.
3. SPF, DKIM and DMARC all `pass` in the headers of at least Gmail and one other provider, with `d=` the sending
   domain.
4. Every link opens on a production host and works; no `localhost`, QA or UAT link.
5. Rendering is acceptable in all mailboxes at desktop and 390px; no placeholder leaks; times in India time.
6. N4, N5 and N6 pass: a `DELIVERED` state is recorded for a real send, and the simulator bounce and complaint
   suppress the address.
7. The ops list shows no `FAILED` row and no `BOUNCED`, `UNDELIVERED` or `COMPLAINED` delivery state for the certification messages except the deliberate simulator
   ones.
8. The owner then records the certification in the product: `POST /api/admin/notifications/readiness/certifications`
   (`PLATFORM_CONFIG`; it refuses without delivery evidence, `notification-readiness.controller.ts:122-134`) and
   `GET .../readiness/certification?markets=IN` reads `LIVE_CERTIFIED` for email on the production environment.

**FAIL** on: any authentication failure; Spam/Junk placement of a required message that remains after fixing; a
wrong-host link; a missing required message; a leaked secret in a subject, log or message; the SNS subscription not
confirmed. **BLOCKED** (never PASS) on: no SES production access; no confirmation route; a mailbox that cannot be
obtained; a message that cannot be triggered.

**Evidence to keep** (outside the repository, with the date, the production commit SHA and who ran it): the S1 to S3
outputs, the DNS answers from two resolvers, the header authentication lines per mailbox, a screenshot of each
message at desktop and 390px, the ops-list rows for the certification messages, and the suppression list entries. No
recipient address, token or secret goes in a screenshot or a report.

## 12. Owner versus engineering

| #   | Step                                                                                                                                               | Owner (AWS, DNS, accounts)     | Engineering                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | Choose the production AWS account and region; create or confirm the SES account                                                                    | Yes                            | Advise (cutover guide)                                                                |
| 2   | Request SES production access, or a re-worded request if DENIED (S1, S5); wait for AWS                                                             | Yes (AWS review is external)   | Draft the wording and sample email                                                    |
| 3   | Create the domain identity and Easy DKIM; custom MAIL FROM                                                                                         | Yes                            | Provide the record list                                                               |
| 4   | Publish DKIM, MAIL FROM MX and SPF, and DMARC at the DNS host (GoDaddy per the cutover guide)                                                      | Yes                            | Verify with dig/nslookup and header results (section 5)                               |
| 5   | Create the configuration set, SNS topic, event destination                                                                                         | Yes (AWS console)              | Check S3/S4 outputs                                                                   |
| 6   | Create the production IAM principal and policy; never reuse the QA SES user                                                                        | Yes                            | Provide the policy (`INFRASTRUCTURE.md` 1.4)                                          |
| 7   | Set production variables on api and worker (section 7) as part of the approved deploy                                                              | Yes (secrets; deploy approval) | Prepare the list; confirm names only                                                  |
| 8   | Decide the production SNS confirmation route (section 6.1)                                                                                         | Decide                         | Implement the chosen option; rehearse on QA                                           |
| 9   | Subscribe the topic to the production webhook URL and confirm it                                                                                   | Yes                            | Run probe N3 and the checks N4 to N8                                                  |
| 10  | Provide the mailboxes (Gmail, Outlook, Yahoo, an Indian provider, a company box) and accounts                                                      | Yes                            | Run the sends, record headers, placement and rendering                                |
| 11  | Run the live purchase and partial refund (S6, S8) that produce messages 1 and 5                                                                    | Yes (live money)               | Observe delivery and state                                                            |
| 12  | Ask engineering to re-send after each DNS or SES change; record the result                                                                         | Request                        | Do it                                                                                 |
| 13  | Remove `ALLOW_UNDELIVERABLE_NOTIFICATIONS`; keep `SMS_ENABLED=false`                                                                               | Yes                            | Confirm via the readiness report that the boot guard is on                            |
| 14  | Record the certification in the product                                                                                                            | Yes (`PLATFORM_CONFIG`)        | Prepare the evidence                                                                  |
| 15  | Add DMARC report reading and bounce monitoring to the daily routine                                                                                | Yes                            | `PILOT-PLAYBOOK.md` M14                                                               |
| E1  | Fix the `PROVIDER-SETUP.md` step 8 claim; document the chosen confirmation route                                                                   | -                              | Docs change                                                                           |
| E2  | Stop QA/UAT synthetic mail to `.test` addresses from bouncing through a shared SES account (use the simulator addresses or the log provider in QA) | Decide                         | Implement; separate sending domains or accounts for QA and production                 |
| E3  | Surface bounced booking emails to support (OP G22 says no screen exists)                                                                           | -                              | A console list or alert; until then the API routes in `PILOT-PLAYBOOK.md` section 3.3 |
| E4  | Record organizer-invite delivery: either email the invite or state plainly in the console that it must be sent                                     | Decide                         | Small product change                                                                  |

Engineering alone can do: the probes, the header checks, the sends, the evidence, E1 to E4 (docs and code), and the
rehearsal on QA. **Engineering cannot do:** anything inside AWS or at the DNS host, SES production access, the production
IAM principal, production variables, the live purchase, and the final recording.

## 13. Rehearsal on QA (allowed now, read or low-risk)

What can be done before production exists, without touching it:

1. Re-run section 2 on QA each week and compare.
2. Confirm the QA flow for the SNS confirmation (steps in `SES-NEW-ACCOUNT-CUTOVER.md` Step 6) so the owner has done
   it once.
3. Send the full matrix of section 8 from QA to the real mailboxes in section 9 (the QA account already delivers to
   real domains: one `DELIVERED` row exists). Look at headers and rendering. This finds template and authentication
   problems early. It proves nothing about production DNS and does not count towards the production PASS.
4. Do not send to the mailboxes in volume, and do not use bulk `.test` traffic on a shared sending domain (item E2 in section 12).

Not done in this review: any write on QA, any AWS or DNS query, any production read, any test send.
