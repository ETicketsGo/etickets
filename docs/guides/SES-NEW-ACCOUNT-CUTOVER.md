# Moving ETicketsGo email to a new AWS account (SES + SNS)

> Written 18 September 2026, when the previous AWS account was blocked. This is the whole
> cutover: verify the domain in the new account, get out of the SES sandbox, wire the event
> webhook, set the variables, and prove a real email arrives. Companion:
> [NOTIFICATION-INTEGRATION](NOTIFICATION-INTEGRATION.md).
>
> **No code changes are needed.** Everything here is AWS configuration plus environment
> variables. The only file this cutover touched was an env template with a wrong variable name.

---

## What "working email" actually requires

Four independent things, and three of them fail silently:

| Leg               | Without it                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| Verified identity | SES refuses the send outright — this one is loud                         |
| Production access | Sends succeed **only to verified recipients**; everyone else is refused  |
| Configuration set | Mail goes out, the row says sent, and **no delivery event ever arrives** |
| Confirmed SNS sub | Same: events are published to a topic nobody is listening on             |

The third is the one that catches people. `SesEmailTransport` names the configuration set on
every send; SES publishes delivery, bounce and complaint events **only** for messages sent with
one attached.

---

## Step 1 — Decide two things first

1. **Region.** The old account used `ap-south-2` (Hyderabad). `ap-south-1` (Mumbai) is the
   older, fuller-featured Indian region and is the safer default. Whatever you pick, **the SNS
   topic must be in the same region as the SES configuration set.**
2. **Sending domain.** Keep `eticketsgo.com` with a sender like `noreply@eticketsgo.com`, and
   use a subdomain such as `mail.eticketsgo.com` for the custom MAIL FROM.

---

## Step 2 — Verify the domain in the new account

SES → **Verified identities** → Create identity → Domain → `eticketsgo.com`.

1. Enable **Easy DKIM** (RSA_2048). SES gives you **three CNAME records** — publish them at
   GoDaddy.
2. **Delete the three DKIM CNAMEs from the old account.** New account, new tokens; the old
   records now point at a blocked account and only cause confusion.
3. Set a **custom MAIL FROM** of `mail.eticketsgo.com` and publish its MX and SPF TXT records.
   This is what makes SPF align with your domain rather than Amazon's.
4. Publish DMARC at `_dmarc.eticketsgo.com` — start with
   `v=DMARC1; p=none; rua=mailto:dmarc@eticketsgo.com`, and tighten to `quarantine` once the
   reports are clean.
5. Wait for the identity to read **Verified** and DKIM **Successful**. DNS can take minutes to
   hours.

---

## Step 3 — Ask for production access, carefully

A brand-new account is in the **SES sandbox**: 200 messages a day, 1/second, and **only to
verified recipients**. The previous account's request came back `DENIED`, so do not resubmit the
same wording.

SES → **Account dashboard** → Request production access. Say, in your own words:

- **Transactional only** — ticket confirmations with a QR code, booking and refund updates.
  No marketing from this account.
- **How recipients got there:** they bought a ticket and gave that address at checkout. There is
  no purchased or uploaded list.
- **How bounces and complaints are handled:** SES publishes them to SNS, the platform receives
  them on a signature-verified webhook, and a hard bounce or complaint **automatically suppresses
  that address** — no further mail is sent to it. (This is real: `suppression.service.ts`, proven
  end to end on QA.)
- **Expected volume**, honestly, e.g. a few hundred a day at pilot scale.
- A **sample** of the actual email.

Until it is approved, you can still test: `*@simulator.amazonses.com` always works, in any
account, and does not touch your reputation.

| Simulator address                   | Produces                                  |
| ----------------------------------- | ----------------------------------------- |
| `success@simulator.amazonses.com`   | a Delivery event                          |
| `bounce@simulator.amazonses.com`    | a hard bounce → `HARD_BOUNCE` suppression |
| `complaint@simulator.amazonses.com` | a complaint → `COMPLAINT` suppression     |

---

## Step 4 — Create sending credentials

IAM → create a user per environment (`eticketsgo-ses-qa`, `-uat`, `-prod`) so one can be revoked
without taking the others down. Attach a policy no wider than this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:<region>:<new-account-id>:identity/eticketsgo.com",
        "arn:aws:ses:<region>:<new-account-id>:configuration-set/eticketsgo-<env>"
      ],
      "Condition": { "StringEquals": { "ses:FromAddress": "noreply@eticketsgo.com" } }
    }
  ]
}
```

Create an access key. It goes into Railway variables and **nowhere else** — never into the repo,
a ticket, or a chat message.

---

## Step 5 — Configuration set and the SNS event destination

1. SES → **Configuration sets** → create `eticketsgo-qa` (one per environment).
2. SNS → create a **standard topic** in the same region, e.g. `eticketsgo-ses-events-qa`.
3. Back in the configuration set → **Event destinations** → Add → Amazon SNS → pick the topic.
   Select at least **Delivery, Hard bounce, Complaint**; Send and Reject are useful too.
4. SNS topic → **Create subscription**:
   - Protocol: **HTTPS**
   - Endpoint: `https://<api-host>/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>`
   - **Leave "Enable raw message delivery" OFF.** Raw delivery strips the SNS envelope, and the
     envelope is what carries the signature — every event would be refused as `unknown_type`.

Generate a fresh `SES_WEBHOOK_SECRET` for this cutover (any long random string). The old one
appeared in retained Railway logs before PR #92 redacted it, and the URL is changing anyway.

---

## Step 6 — Confirm the subscription (a person, deliberately)

The platform **never auto-confirms** an SNS subscription: the signature proves Amazon sent it,
not that we want to be subscribed. The subscription sits at "Pending confirmation" until a human
completes it.

Outside production, the confirmation URL is captured and revealed **once**:

```bash
# as an admin holding PLATFORM_CONFIG
GET  /api/admin/notifications/sns/pending-confirmation          # status only, no token
POST /api/admin/notifications/sns/pending-confirmation/reveal   # the SubscribeURL, once
POST /api/admin/notifications/sns/pending-confirmation/:id/confirmed
```

Open the revealed URL in a browser, check the SNS console shows **Confirmed**, then record it
with the third call. A second reveal returns 409 and discloses nothing.

> **Production gap — decide before go-live.** `reveal` is refused in production by an `APP_ENV`
> allowlist (`LOCAL/DEV/TEST/CI/QA/UAT`), so this flow cannot confirm a production subscription.
> Someone has to choose: extend the allowlist to production, add an encrypted reveal, or confirm
> production by another route. Do not discover this on launch day.

---

## Step 7 — Set the variables on **api and worker**

Per environment, on **both services**:

| Variable                | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| `EMAIL_PROVIDER`        | `ses`                                                |
| `EMAIL_FROM`            | `noreply@eticketsgo.com` (matches the IAM condition) |
| `AWS_REGION`            | the region you chose                                 |
| `AWS_ACCESS_KEY_ID`     | the new key                                          |
| `AWS_SECRET_ACCESS_KEY` | the new secret                                       |
| `SES_CONFIGURATION_SET` | `eticketsgo-<env>`                                   |
| `SES_WEBHOOK_SECRET`    | the secret in the subscription URL                   |
| `SES_SNS_TOPIC_ARNS`    | the new topic ARN                                    |

Three things that will cost you an afternoon otherwise:

- **The worker is the only process that sends.** The API just enqueues. Configure the API alone
  and readiness reports green while every email sits in the worker's log.
- **`AWS_REGION`, not `AWS_SES_REGION`.** The UAT env template used to say the latter; nothing
  reads it, and the transport then fails with "requires AWS_REGION". (Fixed in the template.)
- **Setting a Railway variable redeploys immediately.** Set them together, not one at a time.

---

## Step 8 — Prove it, don't assume it

```bash
GET  /api/admin/notifications/readiness/configuration   # expect email provider=ses, READY
POST /api/admin/notifications/readiness/test-send       # one message to an address you name
GET  /api/admin/notifications/suppressions              # after the simulator tests
```

Run all three simulator addresses through the **normal path** — enqueue and let the worker send;
never call SES directly, because that skips exactly what you are testing. Then check:

- `success@` → the delivery row becomes `DELIVERED`
- `bounce@` → `BOUNCED` plus a `HARD_BOUNCE` suppression
- `complaint@` → `COMPLAINED` plus a `COMPLAINT` suppression
- the webhook POSTs returned 2xx and the logs say `SIGNATURE-VERIFIED`
- no log line anywhere contains the webhook secret (it should read `[REDACTED]`)

Read the status off `NotificationDelivery`, not `Notification`: on success the notification row
stays `SENT` and only the delivery row goes `DELIVERED`.

Once production access is granted, send one real email to a mailbox you control and check the
headers say `signed-by: eticketsgo.com`.

---

## Step 9 — Close out the old account

- Remove the old account's DKIM and MAIL FROM records from DNS (step 2).
- Delete the old IAM access keys.
- Delete the old SNS subscription and topic if the account is still reachable.
- Keep `EMAIL_PROVIDER=log` nowhere near a customer-facing environment: the API refuses to boot
  in production or staging with it, and `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true` is the
  deliberate override — never with real customers.
