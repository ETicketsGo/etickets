# Production SES and SNS checklist (ap-south-1)

Owner requirement (2026-10-20): "Prepare a production SES/SNS configuration checklist using
ap-south-1, with independent production credentials, SNS topic and configuration set."

This is an operator checklist. Work through it in order and tick each box only with evidence in
hand. Nothing here has been run. No value, key or secret appears on this page, and none should be
added. Background and pass criteria: [../pilot/REAL-EMAIL-CERTIFICATION.md](../pilot/REAL-EMAIL-CERTIFICATION.md).
The India SMS checklist is [MSG91-DLT-CHECKLIST.md](MSG91-DLT-CHECKLIST.md).

## Where PROD is today (read-only audit, 2026-10-20)

| Item                                | Today                                                                                        | Target                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| AWS key on PROD api                 | **QA's** IAM user `eticketsgo-ses-qa` (account ending 6280, ap-south-1)                      | production-only IAM user(s), section 7          |
| AWS key on PROD worker              | **none**                                                                                     | the same production SES key as api              |
| `SES_CONFIGURATION_SET`             | `eticketsgo-qa` (QA's)                                                                       | `eticketsgo-prod`                               |
| `SES_SNS_TOPIC_ARNS`                | QA's topic `eticketsgo-ses-events-qa`                                                        | `eticketsgo-ses-events-prod` only               |
| `EMAIL_PROVIDER`                    | `log` (sends nothing)                                                                        | `ses`                                           |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS` | `true` (boot guard off)                                                                      | removed, as the last step                       |
| `EMAIL_FROM`                        | `tickets@eticketsgo.com`                                                                     | unchanged                                       |
| DNS, MAIL FROM                      | `mail.eticketsgo.com`: SPF includes amazonses.com; MX feedback-smtp.ap-south-1.amazonses.com | unchanged                                       |
| DNS, DMARC                          | `p=quarantine`, rua to GoDaddy (onsecureserver.net)                                          | unchanged; see section 4                        |
| DNS, apex SPF                       | Microsoft 365 only                                                                           | unchanged (SES is checked on `mail.`)           |
| DNS, M365 DKIM                      | selectors absent                                                                             | OWNER-CONFIGURATION.md item 4 (support mailbox) |
| SNS subscription confirmation       | not possible in production as built                                                          | PR R1 (#445) merged and deployed                |

## Rules for every PROD change on this page

- Change PROD variables **only** with `C:\etg-wt\prod-deploy-kit\set-var.mjs` (always skipDeploys),
  then apply them with a **pinned deploy**. Never edit or deploy variables from the Railway
  dashboard: a variable change without skipDeploys builds the latest `main`, not the commit PROD
  runs. Full procedure: `C:\etg-wt\PROD-PINNED-DEPLOY-PROCEDURE.md` (sections 1, 4, 6, 8).
- One value per file, outside the repository; delete the file after use. Never paste a value
  into a chat, a ticket, a commit or a screenshot.
- An agent never reads PROD variable values. The owner runs every set-var and deploy.

---

## Gate 1. SES account (ap-south-1)

- [ ] **Production access.** `aws sesv2 get-account --region ap-south-1` for the account PROD will
      send from. PASS: `ProductionAccessEnabled: true`, `SendingEnabled: true`,
      `EnforcementStatus: HEALTHY`, review status not `DENIED`, `SendQuota.Max24HourSend` well above
      pilot volume. If DENIED, follow `docs/guides/SES-NEW-ACCOUNT-CUTOVER.md` step 3 (new wording,
      not a resubmission).
- [ ] **Account decision recorded.** Write down whether PROD shares the AWS account with QA
      (account ending 6280) or has its own. If shared, the domain's sending reputation is shared too:
      QA must send only to the SES mailbox simulator or real team inboxes, never bulk to `.test`
      addresses (REAL-EMAIL-CERTIFICATION.md item E2). Separate credentials, configuration set and
      topic (below) are required either way.

## Gate 2. Domain identity `eticketsgo.com`

- [ ] **Identity verified.** `aws sesv2 get-email-identity --email-identity eticketsgo.com --region ap-south-1`.
      PASS: `VerifiedForSendingStatus: true`.
- [ ] **No address identity for the sender.** There is no separate email-address identity for
      `tickets@eticketsgo.com` in ap-south-1. (SES authorises a send against the most specific
      identity; an address identity would not match the IAM policy in section 7.)
- [ ] **Easy DKIM Successful.** Same command: `DkimAttributes.Status: SUCCESS`, `SigningEnabled: true`.
- [ ] **The three DKIM CNAMEs are at GoDaddy** and match the identity's three tokens exactly:
      `<token>._domainkey.eticketsgo.com  CNAME  <token>.dkim.amazonses.com`, for each token.
      Check each with two resolvers:
      `nslookup -type=CNAME <token>._domainkey.eticketsgo.com 8.8.8.8` and the same with `1.1.1.1`.
      No leftover `_domainkey` CNAME from an older SES account remains.

## Gate 3. Custom MAIL FROM `mail.eticketsgo.com`

- [ ] Identity shows `MailFromAttributes.MailFromDomain: mail.eticketsgo.com`,
      `MailFromDomainStatus: SUCCESS`, `BehaviorOnMxFailure: USE_DEFAULT_VALUE`.
- [ ] `nslookup -type=MX mail.eticketsgo.com 8.8.8.8` returns `10 feedback-smtp.ap-south-1.amazonses.com`.
- [ ] `nslookup -type=TXT mail.eticketsgo.com 8.8.8.8` returns exactly one `v=spf1 include:amazonses.com ~all`.
- [ ] Apex `eticketsgo.com` has exactly **one** `v=spf1` record (today: Microsoft 365). Do **not** add
      amazonses.com to it; SES mail is checked against `mail.eticketsgo.com`.

## Gate 4. DMARC note (no change required)

- [ ] `nslookup -type=TXT _dmarc.eticketsgo.com 8.8.8.8` still shows `p=quarantine`.
- What it means: a message that fails BOTH aligned SPF (via `mail.eticketsgo.com`) and aligned DKIM
  (`d=eticketsgo.com`) goes to spam. Gates 2 and 3 make SES mail pass both.
- Microsoft 365 mail from the support mailbox has **no DKIM** today and can be quarantined by
  the same policy. That is OWNER-CONFIGURATION.md item 4. It does not block SES mail.
- Aggregate reports go to GoDaddy's service (onsecureserver.net). Name the person who reads them
  weekly during the pilot. Do not loosen to `p=none` unless reports show SES mail failing.

## Gate 5. SNS topic `eticketsgo-ses-events-prod`

- [ ] Create a **Standard** topic `eticketsgo-ses-events-prod` in **ap-south-1**. Record its ARN.
- [ ] Topic access policy lets only SES publish, and only for the PROD configuration set:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSesPublishFromProdConfigSetOnly",
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:ap-south-1:<account-id>:eticketsgo-ses-events-prod",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "<account-id>" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:ses:ap-south-1:<account-id>:configuration-set/eticketsgo-prod"
        }
      }
    }
  ]
}
```

- [ ] Do **not** subscribe the topic yet. That is Gate 9, after PR R1 (#445) is deployed.

## Gate 6. Configuration set `eticketsgo-prod`

- [ ] Create configuration set `eticketsgo-prod` in **ap-south-1**. No dedicated IP pool needed.
- [ ] Add one **SNS event destination**, enabled, to topic `eticketsgo-ses-events-prod`, with event
      types exactly: **Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay** (API names
      `SEND, DELIVERY, BOUNCE, COMPLAINT, REJECT, DELIVERY_DELAY`).
      Not Open, not Click (no tracking pixel, no link rewriting).
- [ ] Check: `aws sesv2 get-configuration-set-event-destinations --configuration-set-name eticketsgo-prod --region ap-south-1`
      shows the six types, `Enabled: true`, and the PROD topic ARN.
- [ ] QA's `eticketsgo-qa` set and `eticketsgo-ses-events-qa` topic are left untouched.

## Gate 7. Production IAM (independent of QA)

Never reuse `eticketsgo-ses-qa` on PROD. Replace `<account-id>` in the console; do not write the
account id into the repository.

### 7.1 `eticketsgo-ses-prod`: send email only

- [ ] Create IAM user `eticketsgo-ses-prod` (no console access). Attach this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendFromTicketsAddressThroughProdConfigSetOnly",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:ap-south-1:<account-id>:identity/eticketsgo.com",
        "arn:aws:ses:ap-south-1:<account-id>:identity/tickets@eticketsgo.com",
        "arn:aws:ses:ap-south-1:<account-id>:configuration-set/eticketsgo-prod"
      ],
      "Condition": {
        "StringEquals": { "ses:FromAddress": "tickets@eticketsgo.com" }
      }
    }
  ]
}
```

- [ ] Create **one** access key. Store it in the password manager only.
- Notes: the API calls SES v2 `SendEmail` with simple content, so `ses:SendRawEmail` is not needed.
  Keep `EMAIL_FROM` as the bare address `tickets@eticketsgo.com` (the boot guard refuses a display
  name). If `EMAIL_FROM` ever changes, change the condition first. The `identity/tickets@...` line
  matters only if that address is also verified as its own identity: SES then authorizes against
  the address identity, not the domain.
- This key goes in `SES_AWS_ACCESS_KEY_ID` / `SES_AWS_SECRET_ACCESS_KEY` only, never in `AWS_*`.

### 7.2 `eticketsgo-secrets-prod`: read payment secrets only

PROD reads its payment credentials from Secrets Manager (`payments/*`), and today it does so with
**QA's key**. Removing that key without a replacement stops Razorpay.

- [ ] Create IAM user `eticketsgo-secrets-prod` in the account that holds the PROD `payments/*`
      secrets. Attach:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadPaymentSecretsOnly",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<secrets-region>:<account-id>:secret:payments/*"
    }
  ]
}
```

- [ ] If the secrets use a customer-managed KMS key, also allow `kms:Decrypt` on that key ARN only,
      with condition `kms:ViaService = secretsmanager.<secrets-region>.amazonaws.com`.
- [ ] **Decided: separate keys (choice A), implemented by PR R4.** The SES client reads
      `SES_AWS_ACCESS_KEY_ID` / `SES_AWS_SECRET_ACCESS_KEY` and nothing else in STAGING/PRODUCTION.
      The payment secret store is unchanged: it builds its client from the AWS default chain, which
      reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. So `AWS_*` holds
      `eticketsgo-secrets-prod` and the SES pair holds `eticketsgo-ses-prod`. Do not grant
      `secretsmanager:*` to `eticketsgo-ses-prod`, and do not grant `ses:*` to
      `eticketsgo-secrets-prod`. The boot guard refuses the same key id in both pairs.
- [ ] **PROD must run a commit that contains R4 before the SES pair is used.** An older commit
      ignores `SES_AWS_*` and would sign SES with the secrets key (AccessDenied on every send).
- [ ] Prove the secrets key before removing QA's: after the deploy,
      `GET /api/admin/payments/live-readiness` shows `credentials: passed`, and the api boot log has
      no `Could not bind provider 'razorpay'` (INFRASTRUCTURE.md 1.4 step 6).

### 7.3 Optional: read-only audit role

For a person or agent checking AWS state without any send or secret-read right. Assume it from
an owner identity; never give it an access key on Railway.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOnlySesSnsIamState",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:GetEmailIdentity",
        "ses:ListEmailIdentities",
        "ses:GetConfigurationSet",
        "ses:GetConfigurationSetEventDestinations",
        "ses:ListConfigurationSets",
        "ses:GetSuppressedDestination",
        "ses:ListSuppressedDestinations",
        "sns:GetTopicAttributes",
        "sns:ListTopics",
        "sns:ListSubscriptionsByTopic",
        "sns:GetSubscriptionAttributes",
        "iam:GetUser",
        "iam:ListAccessKeys",
        "iam:GetAccessKeyLastUsed",
        "iam:ListUserPolicies",
        "iam:GetUserPolicy",
        "secretsmanager:ListSecrets",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "*"
    }
  ]
}
```

`DescribeSecret` and `ListSecrets` show names and dates, never values. There is no
`GetSecretValue` here on purpose.

## Gate 8. PROD variables (names only), on api AND worker

The worker sends customer email; the api sends support-form copies and ops alerts. Both load the
same configuration and the same boot guard, so in SES mode each one refuses to start unless it
holds every row marked for it. Configuring the api alone leaves readiness green while nothing
leaves.

| Variable                            | Value to hold                                                      | api | worker |
| ----------------------------------- | ------------------------------------------------------------------ | --- | ------ |
| `SMS_ENABLED`                       | `false` (email-only pilot; set it first)                           | yes | yes    |
| `EMAIL_FROM`                        | `tickets@eticketsgo.com`, bare (already on api; add to worker)     | yes | yes    |
| `AWS_REGION`                        | `ap-south-1` (not `AWS_SES_REGION`, which nothing reads)           | yes | yes    |
| `SES_AWS_ACCESS_KEY_ID`             | `eticketsgo-ses-prod` key id (send email only)                     | yes | yes    |
| `SES_AWS_SECRET_ACCESS_KEY`         | `eticketsgo-ses-prod` secret                                       | yes | yes    |
| `AWS_ACCESS_KEY_ID`                 | `eticketsgo-secrets-prod` key id; replaces QA's key                | yes | yes    |
| `AWS_SECRET_ACCESS_KEY`             | `eticketsgo-secrets-prod` secret                                   | yes | yes    |
| `SECRET_MANAGER_PROVIDER`           | unchanged; confirm present                                         | yes | yes    |
| `AWS_SECRETS_REGION`                | unchanged; confirm present                                         | yes | yes    |
| `SES_CONFIGURATION_SET`             | `eticketsgo-prod` (replaces `eticketsgo-qa`)                       | yes | yes    |
| `SES_SNS_TOPIC_ARNS`                | the `eticketsgo-ses-events-prod` ARN only (QA's ARN removed)       | yes | yes    |
| `SES_WEBHOOK_SECRET`                | new random value, 32+ characters, never QA's                       | yes | yes    |
| `PUBLIC_API_URL`                    | `https://api.eticketsgo.com` (confirm present)                     | yes | no     |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS` | leave `true` for now; removed in Gate 11                           | yes | yes    |
| `EMAIL_PROVIDER`                    | `ses`, set LAST, after every row above is in place on that service | yes | yes    |

`SES_SNS_TOPIC_ARNS` and `SES_WEBHOOK_SECRET` are needed on the worker too: the worker does not
receive webhooks, but the boot guard checks the whole SES configuration on every service.

If `EMAIL_PROVIDER=ses` reaches a service before the rest, that service refuses to boot with
`EMAIL_PROVIDER=ses is not ready in APP_ENV=PRODUCTION` and names each missing item. Check with
`node $K/state.mjs PROD` which deployment is serving; if the failed one replaced the old one, roll
back with the deploy kit (section "Rollback"). Fix the named item; do not set `EMAIL_PROVIDER`
back to `log` to hide it unless rolling back.

Commands (Git Bash, from the repo checkout; the token loading is the procedure's section 2):

```sh
TF=/c/Users/srini/OneDrive/Documents/Railway_Token.txt
export RAILWAY_TOKEN="$(grep -i '^PROD:' $TF | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n')"
cd /c/Users/srini/OneDrive/Documents/etickets
K=/c/etg-wt/prod-deploy-kit

node $K/state.mjs PROD        # record the running commit and every deployment id (rollback ids)
node $K/triggers.mjs PROD     # every code service: triggers=NONE, auto-deploy disabled

# One run per variable per service. Each must end with
# "no deployment started on any service in 60 s". On ALERT: node $K/deps.mjs PROD 2, then section 8.
CONFIRM_PROD_VARIABLE=api:SMS_ENABLED    node $K/set-var.mjs PROD api    SMS_ENABLED    --from-file <file>
CONFIRM_PROD_VARIABLE=worker:SMS_ENABLED node $K/set-var.mjs PROD worker SMS_ENABLED    --from-file <file>
CONFIRM_PROD_VARIABLE=api:EMAIL_PROVIDER node $K/set-var.mjs PROD api    EMAIL_PROVIDER --from-file <file>
# ... repeat for every row of the table, on api and on worker.

# Apply with a pinned deploy of the commit PROD already runs (or the approved release), api first:
SHA=<40-character commit from state.mjs or the approved release>
CONFIRM_PROD_DEPLOY=api@$SHA    node $K/deploy-pinned.mjs PROD api    $SHA
CONFIRM_PROD_DEPLOY=worker@$SHA node $K/deploy-pinned.mjs PROD worker $SHA
```

- [ ] Every set-var ended with no deployment started.
- [ ] Both pinned deploys exited 0 at `$SHA`; `node $K/state.mjs PROD` agrees.
- [ ] `curl -s https://api.eticketsgo.com/api/health` returns ok.
- [ ] `GET /api/admin/notifications/readiness/configuration`: IN email `provider: ses`,
      `configState: READY`, no missing keys.
- [ ] Razorpay check from Gate 7.2 passes.
- [ ] Delete the old QA access key from PROD in this change (it is replaced, not added to). Do not
      delete the QA user itself; QA still uses it.

## Gate 9. Subscribe the topic (requires PR R1 (#445) merged and deployed)

As built, production cannot confirm an SNS subscription (REAL-EMAIL-CERTIFICATION.md 6.1). PR R1 (#445)
adds secure auto-confirmation in production. Do not subscribe before PR R1 (#445) is merged and PROD runs
a commit that contains it.

- [ ] PROD api runs a commit that includes PR R1 (#445) (`state.mjs` commit vs the R1 merge commit).
- [ ] Subscribe topic `eticketsgo-ses-events-prod`, protocol **HTTPS**, endpoint
      `https://api.eticketsgo.com/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>`.
- [ ] Raw message delivery **off**.
- [ ] `aws sns list-subscriptions-by-topic --topic-arn <prod topic arn> --region ap-south-1`: the
      subscription is an ARN, not `PendingConfirmation`.
- [ ] No proxy, WAF or CDN rule rewrites or rejects `text/plain` on that path.
- [ ] api logs contain no webhook secret (the path is logged as `[REDACTED]`).

## Gate 10. Verification

Use `POST /api/admin/notifications/readiness/test-send` (PLATFORM_CONFIG, channel `email`), which
sends through the normal path. During this gate `ALLOW_UNDELIVERABLE_NOTIFICATIONS` is still set.

- [ ] **Simulator success:** test-send to `success@simulator.amazonses.com`. Delivery row reaches
      `DELIVERED`.
- [ ] **Simulator bounce:** `bounce@simulator.amazonses.com`. A new `HARD_BOUNCE` entry in
      `GET /api/admin/notifications/suppressions`.
- [ ] **Simulator complaint:** `complaint@simulator.amazonses.com`. A new `COMPLAINT` entry.
- [ ] **One real inbox (Gmail):** a team mailbox. Inbox, not spam. "Show original":
      `SPF: PASS` (for `mail.eticketsgo.com`), `DKIM: PASS` with `d=eticketsgo.com`, `DMARC: PASS`.
      No "via amazonses.com" in the sender line.
- [ ] **Rows are real:** `GET /api/admin/notifications?channel=email&limit=10` shows the test rows
      with `provider: ses` and a non-null `providerMessageId`, never `log`.
- [ ] **Callbacks arrive:** `GET /api/admin/notifications/readiness/configuration` shows IN email
      `webhookState: OBSERVED`; `GET /api/admin/notifications/readiness?markets=IN` shows
      `callbacksAwaitingCorrelation: 0`.
- [ ] Then the full message matrix of REAL-EMAIL-CERTIFICATION.md sections 8 and 9 (booking,
      guest link, password reset, refund, show cancelled) before any public sale.

## Gate 11. Arm the boot guard (last)

Only after Gate 10 passes.

- [ ] Confirm `SMS_ENABLED=false` on api and worker (the email guard stays on; SMS is declared off).
- [ ] Remove the escape hatch on both services, then apply with a pinned deploy:

```sh
CONFIRM_PROD_VARIABLE=api:ALLOW_UNDELIVERABLE_NOTIFICATIONS    node $K/set-var.mjs PROD api    ALLOW_UNDELIVERABLE_NOTIFICATIONS --delete
CONFIRM_PROD_VARIABLE=worker:ALLOW_UNDELIVERABLE_NOTIFICATIONS node $K/set-var.mjs PROD worker ALLOW_UNDELIVERABLE_NOTIFICATIONS --delete
CONFIRM_PROD_DEPLOY=api@$SHA    node $K/deploy-pinned.mjs PROD api    $SHA
CONFIRM_PROD_DEPLOY=worker@$SHA node $K/deploy-pinned.mjs PROD worker $SHA
```

- [ ] Both services boot. If either refuses with "Notifications cannot be delivered in this
      environment", read the named line and fix that variable; do not put the escape hatch back
      to hide it.
- [ ] `curl -s https://api.eticketsgo.com/api/capabilities` shows `phoneSignIn: false` and
      `phoneSignInCountries: []`.
- [ ] One more simulator success send after the deploy.

## What stays disabled until its gate passes

| Setting             | Value until its gate passes                            | Gate                                                  |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `EMAIL_PROVIDER`    | `log`, with the escape hatch on                        | Gates 1-8 (this page)                                 |
| `SMS_ENABLED`       | `false`                                                | MSG91-DLT-CHECKLIST.md (India) / Twilio gate (US, CA) |
| `SMS_PROVIDER`      | `log`; `SMS_PROVIDER_BY_MARKET` unset                  | same                                                  |
| `WHATSAPP_PROVIDER` | `log`; `WHATSAPP_PROVIDER_BY_MARKET` unset             | MSG91-DLT-CHECKLIST.md, WhatsApp gate                 |
| Phone sign-in tab   | hidden: `/api/capabilities` `phoneSignInCountries: []` | follows `SMS_ENABLED=false`                           |
| `PUSH_PROVIDER`     | `log`                                                  | not in this pilot                                     |

## Rollback

Record the api and worker deployment ids from `state.mjs` before Gate 8. Those are the rollback
points.

1. **Email misbehaves, everything else fine (fastest):** with set-var, set `EMAIL_PROVIDER=log`
   and `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true` on api and worker, then
   `CONFIRM_PROD_REDEPLOY=<svc>@<currentDeploymentId> node $K/redeploy-same.mjs PROD <svc>`.
   Mail stops; nothing else changes.
2. **Boot fails or Razorpay breaks after the key change:**
   `CONFIRM_PROD_ROLLBACK=<svc>@<id> node $K/rollback.mjs PROD <svc> <id> <commitPrefix>` to the
   recorded pre-change ids. A rollback restores the old image AND the old variable snapshot (QA's
   key, `EMAIL_PROVIDER=log`). The variables still listed on the service are then not in the
   container: fix them with set-var before the next deploy.
3. **Callbacks wrong or noisy:** disable the SES event destination, or unsubscribe the HTTPS
   endpoint. Sending continues; delivery states stop updating.
4. **Key exposed:** deactivate the access key in IAM first, then create a new one and set it with
   set-var and a pinned deploy.
5. Never restore QA's AWS key on PROD by hand as a "fix"; use option 2, then repeat Gate 8.

## Evidence to attach (outside the repository)

Date, the PROD commit SHA, and who ran it, for each item. No key, secret, token or recipient
address in any screenshot.

- [ ] `sesv2 get-account` output (Gate 1)
- [ ] `sesv2 get-email-identity eticketsgo.com` output: verified, DKIM SUCCESS, MAIL FROM SUCCESS
- [ ] DNS answers from two resolvers: 3 DKIM CNAMEs, MAIL FROM MX and TXT, apex SPF, DMARC
- [ ] Configuration set event destination output (six types, PROD topic)
- [ ] SNS topic policy and the confirmed subscription (`list-subscriptions-by-topic`)
- [ ] IAM: user names, attached policy JSON, `ListAccessKeys` showing one key each, and the Gate 7
      choice (A or B)
- [ ] set-var and deploy-pinned outputs (Gates 8 and 11), and `state.mjs` before and after
- [ ] Readiness configuration showing `ses`, `READY`, `OBSERVED`
- [ ] Simulator rows: DELIVERED, HARD_BOUNCE suppression, COMPLAINT suppression
- [ ] Gmail "Show original" authentication lines (SPF, DKIM, DMARC pass)
- [ ] Notification rows with `provider: ses` and a `providerMessageId`
- [ ] `live-readiness` showing `credentials: passed` after the key change
- [ ] `/api/capabilities` after Gate 11
