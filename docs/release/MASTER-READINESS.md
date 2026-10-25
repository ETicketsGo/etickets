# ETicketsGo master readiness tracker

The one list of everything still open. Every item stays here until it has evidence of
completion. Update it at the end of every session; never delete an open row because something
newer became urgent.

- **Last updated:** 2026-10-25 (UTC), main `73e2ff03` plus this PR.
- **Owner** = the account holder (Srinivas). **Eng** = engineering sessions.
- Status words: **DONE** (evidence given), **OPEN**, **BLOCKED** (waiting on the named
  dependency), **WATCH** (done, needs one more observation).

## 0. Production state (read-only, 2026-10-25 ~17:40 UTC)

| Service       | Commit     | Deployment                             | Note                                             |
| ------------- | ---------- | -------------------------------------- | ------------------------------------------------ |
| customer-web  | `62d6d453` | `7305672b-bdf1-4573-a99b-a34e96776639` | SEO + privacy v2 + /delete-account               |
| api           | `2439e254` | `ab71fb7e-734e-44e1-8bbc-5380a1d1ebbc` | 73e2ff03 awaits approval (section 4)             |
| worker        | `2439e254` | `a2566b03-933c-4ff8-9b80-225cf2df5ce6` |                                                  |
| admin-web     | `2439e254` | `da92a8ac-2772-460a-8fc1-41016aad3981` |                                                  |
| organizer-web | `2439e254` | `d2cd0146-8615-4fdd-b660-edf04ac6b97b` |                                                  |
| db-seed       | `311ebb79` | `c1275379-fdd0-46e5-93e3-8f4b7b22a269` | nightly backup cron (02:00 UTC); never deploy it |
| Postgres      | -          | `645869eb-996a-4920-9a3e-57357a1d2d9a` | volume 234 MB, READY                             |
| Redis         | -          | `ad983563-6c93-4b3b-b952-effe69352bd0` |                                                  |

QA runs `73e2ff03` on all five code services (verify-deployed: current, probes pass). UAT has
no DNS (`uat.eticketsgo.com` does not resolve) and is behind main.

## 1. Incident 2026-10-25: production was down ~7 hours

| ID   | Item                                                                                                                                                                                                                                                                                | Status          | Next action                                                                                                                                                                 | Party       | Approval |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| INC1 | Every PROD deployment (all web apps, api, worker, db-seed, Postgres, Redis) went REMOVED between 10:18:42 and 10:19:05 UTC, no creator recorded. Railway edge answered "Application not found" (404, `x-railway-fallback: true`) on every host. This is the 404 Search Console saw. | DONE (restored) | Restored 17:30:44 UTC by a bulk redeploy from the owner account; same commits. Verified after: sitemap 200, SEO 23/23, api /health and /ready 200, admin and organizer 200. | Owner       | -        |
| INC2 | **Root cause unknown.** Simultaneous removal with no creator suggests a platform action (billing, usage limit, plan, or a manual "remove").                                                                                                                                         | OPEN P0         | Check Railway: Billing/usage, account notifications, project Activity at 10:18 UTC. Record the cause here.                                                                  | Owner       | -        |
| INC3 | Nothing alerted for ~7 hours.                                                                                                                                                                                                                                                       | IN PR           | Hourly external check added (`.github/workflows/uptime.yml`). Owner: make sure GitHub Actions failure emails reach a watched inbox, or add a paid uptime monitor.           | Eng + Owner | -        |
| INC4 | Backups after the restore: db-seed is a new deployment (17:30). Its cron runs with the variables captured at creation.                                                                                                                                                              | WATCH           | 2026-10-26 after 02:00 UTC: read db-seed logs for `backup written` + `verified yes` (read-only `logs.mjs`).                                                                 | Eng         | -        |
| INC5 | Last verified PROD backup before the incident: `etg-production-2026-10-25T02-00-04-819Z.dump` (written + read back 02:00:11 UTC). Data volume intact after restore (234 MB).                                                                                                        | DONE            | -                                                                                                                                                                           | -           | -        |

## 2. Website SEO and indexing

| ID  | Item                                                                            | Status  | Evidence / next action                                                                                                                                                             | Party | Approval |
| --- | ------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| S1  | SEO code live on PROD customer-web (`62d6d453`, PR #486)                        | DONE    | `node apps/customer-web/scripts/seo-check.mjs https://www.eticketsgo.com --expect indexable` 23/23 at 17:3x UTC after the restore; sitemap GET+HEAD 200 `application/xml`, 26 URLs | Eng   | done     |
| S2  | Search Console sitemap shows 404                                                | OPEN    | Caused by INC1. Resubmit (section 9.1) now that it answers 200; status may take hours to refresh.                                                                                  | Owner | -        |
| S3  | Homepage indexing (separate from the sitemap)                                   | OPEN    | URL Inspection > Test live URL > Request indexing (section 9.1). Track "URL is on Google" separately.                                                                              | Owner | -        |
| S4  | Bing Webmaster Tools                                                            | OPEN    | Import from Search Console, submit sitemap (section 9.2).                                                                                                                          | Owner | -        |
| S5  | Event and film pages are client-rendered (SEO content only in metadata/JSON-LD) | OPEN P2 | Server-render event/film details.                                                                                                                                                  | Eng   | PR       |
| S6  | PROD public catalogue is empty (0 events, 0 films)                              | OPEN P1 | Sitemap lists static pages only until real events are published.                                                                                                                   | Owner | -        |
| S7  | QA/UAT non-indexable                                                            | DONE    | QA seo-check `--expect noindex` 24/24; QA Railway host sends `noindex, nofollow`.                                                                                                  | -     | -        |

## 3. DNS and domains

| ID  | Item                                                                                  | Status  | Next action                                                                                        | Party | Approval   |
| --- | ------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- | ----- | ---------- |
| D1  | Apex `eticketsgo.com`: GET `/` 301 to www, any path 404, HEAD 405 (GoDaddy forwarder) | OPEN P1 | Cloudflare migration + redirect rule (`docs/release/DNS-CLOUDFLARE-PLAN.md`).                      | Owner | DNS change |
| D2  | Full zone inventory (SES DKIM CNAMEs are not discoverable publicly)                   | OPEN    | Export the zone file from GoDaddy (DNS > ... > Export) and attach it to the plan before migrating. | Owner | -          |
| D3  | UAT hostnames do not exist in DNS                                                     | OPEN P2 | Decide whether UAT needs public names.                                                             | Owner | -          |

## 4. Production backend rollout (api + worker to `73e2ff03`)

| ID  | Item                        | Status             | Next action                                                                                       | Party       | Approval |
| --- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- | ----------- | -------- |
| B1  | Deployment request prepared | READY FOR REVIEW   | `docs/release/PROD-API-DEPLOY-REQUEST-2026-10-25.md`: diff, migration, backup gate, rollback ids. | Eng         | -        |
| B2  | Approve and run it          | BLOCKED (approval) | Owner approves; Eng runs the kit: backup gate, api, worker, verify.                               | Owner + Eng | Owner    |

## 5. Support and email operations

| ID  | Item                                                                                          | Status  | Evidence / next action                                                                                                                                              | Party       | Approval |
| --- | --------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| E1  | Readable support references `ETG-SUP-YYYY-NNNNNN` (PR #487)                                   | QA DONE | QA migration applied, 19 rows backfilled, new request `ETG-SUP-2026-000020` (POST /support 201). PROD needs B2.                                                     | Eng         | B2       |
| E2  | QA acknowledgement "We have your message [ETG-SUP-2026-000020]" delivered                     | OPEN    | Owner confirms it is in the support@eticketsgo.com inbox (QA uses SES).                                                                                             | Owner       | -        |
| E3  | QA internal support copy not mailed (QA has no `SUPPORT_INBOX_EMAIL`)                         | OPEN P2 | Optional: set QA `SUPPORT_INBOX_EMAIL` to a test mailbox to prove the internal copy by real delivery. Rendering is proven by preview.                               | Owner       | QA var   |
| E4  | PROD emails show Railway hosts (`customer-web-prod.up.railway.app`, `admin-web-prod-1594...`) | OPEN P1 | Change `CUSTOMER_WEB_URL`, `ADMIN_WEB_URL`, `ORGANIZER_WEB_URL` on PROD api AND worker (section 9.4). CORS already allows the official origins (tested 2026-10-25). | Owner + Eng | Owner    |
| E5  | Organizer console and the Android app do not show the support reference                       | OPEN P2 | UI follow-up.                                                                                                                                                       | Eng         | PR       |
| E6  | Refund references `ETG-RFD-...`                                                               | OPEN P2 | Design in `docs/support/REFERENCES.md`; touches the money path, needs owner approval.                                                                               | Eng         | Owner    |
| E7  | Test support request on PROD `cmvncaxg10015uo2zxo94825e`                                      | OPEN    | Owner closes it in the admin console (delivered both mails, screenshot 2026-10-25).                                                                                 | Owner       | -        |

## 6. Privacy policy consistency

| ID  | Item                                                                                                                                                                      | Status  | Next action                                                                                                                                                             | Party | Approval |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| PV1 | PROD website shows privacy v2 (2026-10-25); PROD api (2439e254) registry still has PRIVACY v1 current, so new marketing-EMAIL consent records cite `PRIVACY/<market>/v1`. | OPEN P1 | Fixed by B2 (main's registry returns `PRIVACY/{GLOBAL,US,IN,CA}/v2`, checked 2026-10-25). Historical records are not rewritten; v1 stays in the registry as superseded. | Eng   | B2       |

## 7. Android 1.0.0 and Google Play

| ID  | Item                                                                                    | Status       | Next action                                                                                                                                       | Party | Approval |
| --- | --------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| A1  | Signed AAB 1.0.0 / versionCode 4 (`d4ef7c83`, EAS build 83abb1a8)                       | DONE         | Durable copy: OneDrive `Documents/ETicketsGo-Releases/android-1.0.0-vc4/` (`sha256sum -c SHA256SUMS` OK 2026-10-25). EAS copy expires 2026-11-23. | -     | -        |
| A2  | Upload key EAS-managed (credentials `gPVK3PKg8z`), backup to password manager           | OPEN         | `npx eas-cli credentials` > Android > production > Download keystore.                                                                             | Owner | -        |
| A3  | D-U-N-S for DeepTrics Software Solutions Private Limited                                | OPEN (owner) | Apply / confirm.                                                                                                                                  | Owner | -        |
| A4  | Play organization account + matching payments profile + verified contacts               | BLOCKED (A3) |                                                                                                                                                   | Owner | -        |
| A5  | Internal testing upload of 1.0.0                                                        | BLOCKED (A4) | `docs/PLAY-RELEASE.md` 5.2.                                                                                                                       | Owner | Owner    |
| A6  | Firebase push (EAS `GOOGLE_SERVICES_JSON`, FCM V1 key, `PUSH_PROVIDER=expo`)            | OPEN         | `docs/PLAY-RELEASE.md` 6.2. Needs AAB versionCode 5+.                                                                                             | Owner | Owner    |
| A7  | Sentry (`EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`)                                  | OPEN         | 6.3. Needs versionCode 5+.                                                                                                                        | Owner | -        |
| A8  | Play Integrity for phone codes (`PLAY_INTEGRITY_*` on api)                              | OPEN         | 6.1. Needs the Play app (A4) to link the Cloud project. API code is in B2.                                                                        | Owner | Owner    |
| A9  | App Links fingerprint (`ANDROID_APP_LINKS` on PROD customer-web)                        | BLOCKED (A5) | Play app signing key SHA-256 after the first upload.                                                                                              | Owner | PROD var |
| A10 | Store screenshots (demonstration content, synthetic account) + data safety + privacy v2 | DONE         | PR #485; `store-listing/README.md`.                                                                                                               | -     | -        |
| A11 | Reviewer account on PROD                                                                | OPEN         | Create before production review.                                                                                                                  | Owner | -        |

**What needs a new AAB (versionCode 5 or higher):** turning on push (A6) or crash reporting
(A7), any app code change, and a production listing that claims notifications. Play Integrity
(A8), App Links (A9) and support-reference display on the website do not.

## 8. Production launch and operations

Facts marked "per notes" come from earlier verified sessions and are not re-tested today.

| ID  | Item                                                                                                                                                                        | Status            | Next action                                                                                                              | Party       | Approval |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- | -------- |
| L1  | Backups: nightly dump verified (INC5); **no isolated restore of a PROD dump has ever been drilled**; copies live only in Railway                                            | OPEN P1           | Restore drill into a scratch database; off-Railway copy; enable Railway native volume backups (owner dashboard only).    | Eng + Owner | Owner    |
| L2  | Razorpay live: real UPI purchase confirmed by signed webhook 2026-10-17 (per notes). Payment configuration unchanged by this work.                                          | DONE (pilot)      | Public paid sales still need separate owner approval.                                                                    | Owner       | Owner    |
| L3  | Pilot restrictions (per-order and hold caps, `BOOKING_MAX_*`; coupons off) unchanged                                                                                        | DONE              | Unchanged since the 2026-10-23 release (api untouched today).                                                            | -           | -        |
| L4  | Provider transfers (Razorpay Route / Stripe Connect) stay disabled (standing owner gate)                                                                                    | GATE              | Unchanged.                                                                                                               | Owner       | Owner    |
| L5  | India SMS: PE-TM chain, header ETKTGO and eight templates are **approved** (owner). PROD routes phone codes only for US and CA (`phoneSignInCountries` checked 2026-10-25). | OPEN P0 for India | Configure MSG91 credentials and template ids on PROD api/worker and `SMS_PROVIDER_BY_MARKET` IN=msg91; test on QA first. | Owner + Eng | Owner    |
| L6  | US SMS (Twilio): OTP delivered to the owner's number 2026-10-24 (per notes); STOP/START keyword test pending                                                                | OPEN P2           | Owner replies STOP/START from that phone.                                                                                | Owner       | -        |
| L7  | Transactional email: PROD SES live and verified 2026-10-24 (per notes)                                                                                                      | DONE              | -                                                                                                                        | -           | -        |
| L8  | Real organizers and published events on PROD                                                                                                                                | OPEN P0 for sales | Onboard organizers; publish events.                                                                                      | Owner       | -        |
| L9  | Ticket QR + gate check-in (camera scanner, manual entry, offline devices exist; per notes)                                                                                  | OPEN P1           | Run one end-to-end check-in on PROD with a real event before sales.                                                      | Owner + Eng | -        |
| L10 | Refund and settlement safeguards; FIN-1 payout netting fix awaits owner decision (per notes)                                                                                | OPEN P1           | Owner decision on FIN-1.                                                                                                 | Owner       | Owner    |
| L11 | GST: PROD charges tax 0 on INR (per notes); activation changes buyer totals                                                                                                 | OPEN P1           | Owner decision before India sales.                                                                                       | Owner       | Owner    |
| L12 | Admin MFA deferred on PROD (`MFA_ENROLLMENT=deferred`, per notes)                                                                                                           | OPEN P1           | Enroll every admin; switch to enforced.                                                                                  | Owner       | Owner    |
| L13 | Monitoring: no paid uptime/alerting; Sentry on api only if DSN set                                                                                                          | OPEN P1           | INC3 workflow is the minimum; add a real uptime service + on-call contact.                                               | Owner       | -        |
| L14 | Support operations: shared inbox works (PROD screenshots 2026-10-25); no SLA/rota documented                                                                                | OPEN P2           | Name who answers support and how fast.                                                                                   | Owner       | -        |

## 9. Runbooks for the owner actions above

### 9.1 Search Console (existing Domain property `eticketsgo.com`, already verified by TXT)

1. Open https://search.google.com/search-console and pick the `eticketsgo.com` property.
2. **Indexing > Sitemaps.** If `https://www.eticketsgo.com/sitemap.xml` is listed with an error,
   open it and select **Remove sitemap** (three-dot menu), then enter
   `https://www.eticketsgo.com/sitemap.xml` under "Add a new sitemap" and **Submit**. Status
   should become **Success** with 26 discovered pages; "Couldn't fetch" for the first hours is
   normal - check again later. Do not submit `https://eticketsgo.com/sitemap.xml` (the apex
   answers 404 until D1).
3. **URL Inspection:** paste `https://www.eticketsgo.com/`, **Test live URL**, confirm
   "URL is available to Google", then **Request indexing**. This is tracked as S3, apart from
   the sitemap.
4. Check **Pages** and **Settings > Crawl stats** after a few days.

### 9.2 Bing Webmaster Tools

1. https://www.bing.com/webmasters > **Import** from Google Search Console (sign in with the
   same Google account) > select `eticketsgo.com`.
2. **Sitemaps > Submit sitemap** > `https://www.eticketsgo.com/sitemap.xml`.
3. **URL Inspection** on the homepage after the sitemap is processed.

### 9.3 Apex and DNS

See `docs/release/DNS-CLOUDFLARE-PLAN.md`.

### 9.4 PROD URL variables (E4)

Values: `CUSTOMER_WEB_URL=https://www.eticketsgo.com`,
`ADMIN_WEB_URL=https://admin.eticketsgo.com`,
`ORGANIZER_WEB_URL=https://organizer.eticketsgo.com`, on **api and worker**.

Pre-checks done 2026-10-25: the three hosts resolve to Railway and answer 200; CORS on the PROD
API answers `access-control-allow-origin` for all three (and still for the old customer-web
Railway host, so open sessions keep working). `CUSTOMER_WEB_URL` also builds the Razorpay
return URL, password-reset and guest-booking links; those routes exist on www (the same
service). QA already runs with its official domains.

Procedure (never the dashboard Deploy button): `set-var.mjs PROD api CUSTOMER_WEB_URL --from-file`
(skipDeploys) for each variable on api and worker, then `redeploy-same.mjs PROD api` and
`redeploy-same.mjs PROD worker`. Verify: request a password reset to a test account and check
the link host; submit a test support message and check the footer and admin link; one
Razorpay test is NOT possible on PROD without a real payment, so check the order's
`callback_url` host in the API logs instead. Rollback: set the old values the same way.

## 10. Release decisions (2026-10-25)

| Area                       | Decision                     | Why                                                                                                                                                   |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website SEO/indexing       | **GO**                       | Live and verified 23/23 after the restore; owner resubmits the sitemap (S2) and requests indexing (S3).                                               |
| DNS and domains            | **NO-GO**                    | Apex broken (D1); zone export needed (D2).                                                                                                            |
| Support/email operations   | **CONDITIONAL**              | Works on PROD today (raw ids, Railway hosts); readable refs need B2, official links need E4.                                                          |
| Backend production rollout | **READY, awaiting approval** | B1 prepared; one additive migration; backup gate and rollback ready.                                                                                  |
| Android internal testing   | **NO-GO (blocked)**          | Organization account (A3/A4) not verified.                                                                                                            |
| Android production launch  | **NO-GO**                    | After internal testing, push/Sentry decisions, App Links, reviewer account, real events.                                                              |
| India ticket-sales launch  | **NO-GO**                    | INC2 cause unknown; SMS for India not configured (L5); no real events (L8); restore never drilled (L1); GST, FIN-1 and admin MFA decisions (L10-L12). |
