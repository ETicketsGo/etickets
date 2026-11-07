# Admin console access gate (admin.eticketsgo.com)

Status: **prepared, OFF everywhere.** Nothing changes in any environment until the owner sets
`ADMIN_ACCESS_GATE` on a service. Production needs the owner's explicit approval (P0, AR-34/42).

## 1. Why

`admin.eticketsgo.com` answers anyone on the internet. Its sign-in, MFA and role checks protect
the data, but the Next.js server itself is reachable before any of that runs, so every Next.js
vulnerability (GHSA-2464 image optimizer, GHSA-p3m5 Server Actions) is reachable anonymously.
Internet scanners have probed Server Actions on all three web apps daily since at least
2026-10-08, most often admin (docs/security/INCIDENT-2026-11-06-NEXT-IMAGE-OPTIMIZER.md).
An identity-aware gate means only known administrators, with MFA, ever reach the server.

## 2. Design

```
browser --> Cloudflare Access (Entra ID sign-in + MFA, allow-list) --> Railway --> admin-web
                         | signs each request it lets through                    |
                         +------------- Cf-Access-Jwt-Assertion -----------------+
                                                                  middleware.ts verifies it
```

Two layers, both needed:

1. **Cloudflare Access** in front of the hostname: signs people in with Microsoft Entra ID (the
   company's Microsoft 365 tenant, which already hosts eticketsgo.com and deeptrics.com mail),
   requires MFA, and lets in only listed administrators.
2. **Origin check** in the app (`apps/admin-web/middleware.ts`, `lib/access-gate.ts`): Cloudflare
   only protects traffic that goes through it. Railway serves the same app on its generated name
   (`admin-web-prod-b465.up.railway.app` in production) and on its edge with any Host header, so
   the app refuses every request that does not carry a valid Access token for this application:
   RS256, issuer `https://<team>.cloudflareaccess.com`, audience = the application's AUD tag,
   not expired, signed by a key from the team's public certs endpoint.

**Unchanged:** the console's own sign-in, TOTP MFA, step-up, roles and capabilities. Passing
Access only lets a person reach the sign-in page.

**Not covered:** `api.eticketsgo.com`. The console's browser code calls the API directly
(cross-origin), and the API also serves the storefront and organizer apps, so it cannot sit
behind this gate. Its `/admin/*` routes keep their own JWT, role, MFA and step-up checks.

### Settings (admin-web service)

| Variable                | Value                                                     | Secret? |
| ----------------------- | --------------------------------------------------------- | ------- |
| `ADMIN_ACCESS_GATE`     | `off` (default; also unset/unknown), `report`, `enforce`  | no      |
| `CF_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`                             | no      |
| `CF_ACCESS_AUD`         | the Access application's "Application Audience (AUD) Tag" | no      |

- `report` checks every request and logs `admin_access_gate_would_refuse` (reason, method and
  path, never the token) but refuses nothing.
- `enforce` answers 403 to anything without a valid token.
- `/api/health` is always answered, because Railway's health check calls the container
  directly, never through Cloudflare. It returns a fixed `{status:"ok"}`.
- An unknown mode means `off`, so a typo cannot lock anyone out.
- In `enforce`, a missing or malformed team domain or AUD **fails closed**: every request except
  the health check gets 403, and the server logs `admin_access_gate_misconfigured` once.
- The team domain must be a `*.cloudflareaccess.com` name, so the keys can never be fetched
  from another host.
- The settings are read when the server starts (Node.js middleware). A change needs a redeploy,
  not a rebuild.

### What must keep working (checked)

| Flow                                 | Behind the gate                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, MFA enrolment, step-up      | Pages behind Access; credentials go to the API, which is not gated                                                                     |
| Staff invites (`/invite/<token>`)    | The invitee must be **added to the Access policy before the invite is sent**, or Cloudflare stops them before the page                 |
| Links in emails (`ADMIN_WEB_URL`)    | Open after the Access sign-in                                                                                                          |
| Server-to-server calls to admin-web  | None: the api and worker use `ADMIN_WEB_URL` only to build links                                                                       |
| Identity-provider callback           | On the Cloudflare team domain (`/cdn-cgi/access/callback`), not on admin-web; the app has no OAuth callback of its own                 |
| Railway health check                 | Exempt (above)                                                                                                                         |
| Web app manifest / home-screen icons | Browsers fetch the manifest without cookies, so Access may refuse it: the "install app" prompt may not appear. Cosmetic; not exempted. |

### Crawlers (not a security control)

`/robots.txt` disallows everything, every response carries
`X-Robots-Tag: noindex, nofollow, noarchive`, and every page has `<meta name="robots"
content="noindex, nofollow">`. These only keep honest crawlers out of search results.

## 3. Owner setup

The repository is public: put no team-specific values, client secrets or AUD tags in it.

### 3.1 Prerequisite: the zone on Cloudflare

Cloudflare Access only works for hostnames Cloudflare proxies. `eticketsgo.com` is on GoDaddy
DNS today, and `admin` points straight at Railway. Run the existing migration plan first:
`docs/release/DNS-CLOUDFLARE-PLAN.md` (prepared 2026-10-25, needs the GoDaddy zone export,
including the SES DKIM records). In it, `admin` and `admin-qa` must be **Proxied** (orange
cloud), SSL/TLS mode **Full (strict)**, and a cache rule must bypass the cache for the admin
hosts (already in that plan).

If the owner does not want to move DNS, the equivalent without Cloudflare is an identity-aware
proxy (oauth2-proxy with Entra ID) as the only public service, with admin-web on Railway's
private network and no public domain. That is a separate, larger change; ask for it.

### 3.2 Cloudflare Zero Trust

1. Cloudflare dashboard > Zero Trust: create the organisation and choose the **team name**
   (gives `<team>.cloudflareaccess.com`). The Free plan covers up to 50 users.
2. Protect the Cloudflare account itself: MFA on every Cloudflare login, at least two owners
   (break-glass, section 5).

### 3.3 Identity provider: Microsoft Entra ID

1. Entra admin center > App registrations > New registration, e.g. "Cloudflare Access - ETicketsGo
   admin". Single tenant. Redirect URI (Web):
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
2. Certificates & secrets: create a client secret. Paste it into Cloudflare only: never into
   Railway, the repository, a chat or a ticket. Note its expiry date in the owner calendar.
3. API permissions (Microsoft Graph, delegated): `openid`, `email`, `profile`, `offline_access`,
   `User.Read`; plus `Directory.Read.All` (admin consent) only if policies use Entra groups.
4. Cloudflare Zero Trust > Settings > Authentication > Add new > **Azure AD**: application
   (client) ID, client secret, directory (tenant) ID. Turn on "Support groups" if using groups.
   Use **Test** and confirm the returned identity shows the right email.
5. **MFA, enforced by Entra.** Conditional Access: a policy for the "Cloudflare Access" enterprise
   app, all included admin users, **Grant: require multifactor authentication** (phishing-resistant
   strength if available). Without Entra ID P1, turn on Security defaults (MFA for everyone).
   Then sign in through Access once and confirm in Zero Trust > Logs > Access that the identity's
   `amr` includes `mfa`. Only then add the Cloudflare **Authentication method: mfa** requirement
   (step 3.4.4) as a second check: if Entra does not send `amr`, that rule refuses everyone.

### 3.4 The Access application (one for production, one for QA)

1. Zero Trust > Access > Applications > Add > **Self-hosted**.
2. Name "ETicketsGo admin (PROD)", domain `admin.eticketsgo.com`, no path (whole host). QA:
   a separate application for `admin-qa.eticketsgo.com` with its own policy, so QA testers never
   get production access.
3. Session duration: 8 hours (a working day; the console's own session is separate). Identity
   providers: **only** Azure AD, with "Instant auth". **Turn off One-time PIN** for this app.
4. Policy "Platform administrators", action **Allow**:
   - Include: **Emails** listing the named administrators (or an Entra group, e.g.
     `etg-platform-admins`).
   - Require: Login methods = Azure AD; and, after 3.3.5 is confirmed, Authentication method =
     `mfa`.
   - No Bypass or Service Auth policies. Never "Everyone".
5. Settings: under Cookies, set **SameSite = Lax** and turn on **HTTP Only**. Leave "Binding
   Cookie" off unless it is tested. CORS: none needed (the console calls the API, not itself).
6. Save, then copy **Overview > Application Audience (AUD) Tag** (64 hex characters).

### 3.5 Railway variables, staged (no deployment)

On the admin-web service of the environment (QA first), set with **skipDeploys**, as a
variable change without it builds `main` HEAD (memory: variable-change-deploys-main):

```
ADMIN_ACCESS_GATE=report
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<AUD tag of THIS environment's application>
```

Add the three names to that environment's admin-web list in `.railway/variables.ts` (the IaC
keeps only the names it lists), then deploy the exact intended commit of admin-web.

## 4. Rollout (QA first; production only with explicit approval)

| Step | Action                                                                                                         | Proof before the next step                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Merge this PR. Every environment stays `off`                                                                   | QA admin-web on the merge commit: pages, sign-in, robots.txt and `X-Robots-Tag` as expected                                                                             |
| 2    | QA: zone proxied, Access app for `admin-qa`, gate `report`                                                     | Through Cloudflare: sign-in with Entra + MFA works; the console's own sign-in, MFA and a step-up action work; logs show **no** `would_refuse` for that traffic          |
| 3    | QA: request the generated name `admin-web-qa.up.railway.app` directly                                          | Logs show `would_refuse ... no-token` for it                                                                                                                            |
| 4    | QA: gate `enforce`                                                                                             | Cloudflare path works end to end; the generated name and a direct Railway request answer 403; `/api/health` 200; an invite to a policy member works                     |
| 5    | PROD (approval): Access app for `admin`, gate `report` for one working day                                     | As step 2 with real administrators; zero `would_refuse` from their sessions                                                                                             |
| 6    | PROD (approval): gate `enforce`                                                                                | As step 4; then 24 h of logs: scanners see 403 at Cloudflare or at the origin                                                                                           |
| 7    | PROD (approval): remove the generated service domain `admin-web-prod-b465.up.railway.app` (Railway > Settings) | It no longer resolves to the console. The origin check already refuses it; this removes the reachable surface. Update `.railway/railway.ts` if it lists service domains |

## 5. Rollback and break-glass

- **The gate refuses real administrators:** set `ADMIN_ACCESS_GATE=report` (or `off`) on
  admin-web and redeploy the same commit. The console's own sign-in, MFA and roles still
  protect it.
- **Cloudflare Access or Entra is down:** same as above. Optionally turn the Access application
  off in Zero Trust. Re-enable once restored and return to `enforce`.
- **Locked out of Cloudflare:** a second Cloudflare account owner with its own MFA (3.2.2).
- Every change to these settings, and its reason, goes in the readiness register (AR-34).

## 6. Tests

- `apps/admin-web/lib/access-gate.test.ts`: off by default and for unknown values; only the
  health check exempt; valid token accepted; missing, wrong-audience, wrong-issuer, expired,
  unpublished-key, `alg: none` and garbage tokens refused; misconfigured `enforce` fails closed;
  the key host must be a Cloudflare team domain.
- Built server, each mode, from a local run: `off` changes nothing; `report` refuses nothing and
  logs the would-be refusals; `enforce` answers 403 to pages, `/runtime-config.js`,
  `/_next/image` and Server Action posts, and 200 to `/api/health`.

## 7. Owner checklist: Cloudflare zone cutover and the first real QA test

Nothing here is done without the owner. The zone move changes how every eticketsgo.com name
resolves, including mail. It is planned in `docs/release/DNS-CLOUDFLARE-PLAN.md`; this section
is the go/no-go list for it, as it affects the admin gate.

### 7.1 Before the nameserver change (public DNS re-read 2026-11-07: unchanged since 2026-10-25)

| Item                             | Check                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Full zone export                 | GoDaddy > DNS > Export (BIND). Re-create every record in Cloudflare, including the SES DKIM CNAMEs (`<token>._domainkey`), the `_railway-verify.*` TXT records, `_dmarc`, the SPF TXT and the Search Console TXT                                                                                                                                                                     | DKIM and verification records cannot be discovered from outside; a missing one breaks mail signing or a Railway custom domain |
| Mail stays DNS only (grey cloud) | `@` MX (Microsoft 365), `mail` MX + TXT (SES MAIL FROM), `autodiscover`, `enterpriseregistration`, `enterpriseenrollment`                                                                                                                                                                                                                                                            | Cloudflare cannot proxy mail; proxying the Microsoft names breaks Outlook and Intune                                          |
| Web names                        | `www`, `api`, `organizer`, `admin` and the `-qa` names: CNAME to the same `*.up.railway.app` targets as today                                                                                                                                                                                                                                                                        | No target changes                                                                                                             |
| Proxy (orange) only where needed | `admin` and `admin-qa` must be proxied for Access. `api`, `www` and `organizer` can stay DNS only at first                                                                                                                                                                                                                                                                           | The smallest change that enables the gate                                                                                     |
| SSL/TLS                          | Mode Full (strict). Railway keeps serving its certificate for each custom domain: before proxying a name, confirm Railway shows its certificate as valid; after proxying, confirm a renewal still succeeds                                                                                                                                                                           | Flexible mode would send plain HTTP to Railway; a failed renewal would surface weeks later                                    |
| TTLs                             | Lower the GoDaddy TTLs to 300 s at least 24 h before                                                                                                                                                                                                                                                                                                                                 | Makes the rollback (7.4) fast                                                                                                 |
| Non-browser traffic              | Nothing non-browser calls admin-web: the api and worker only build links to it, and Railway's health probe calls the container directly. Provider webhooks (Razorpay, Stripe, SES/SNS `text/plain`, MSG91) and the mobile app call `api`, which is NOT behind Access. If `api` is ever proxied: Bot Fight Mode off for it (or a WAF skip rule for the webhook paths), and no caching | Access or bot challenges on `api` would drop paid webhooks                                                                    |
| Monitoring                       | If an external uptime monitor checks admin, point it at `/api/health` and add an Access Bypass policy for that exact path only (the origin already exempts it)                                                                                                                                                                                                                       | Otherwise the monitor sees the Access login page                                                                              |

### 7.2 Identity (Entra ID): confirm before the Access application goes live

- The app registration redirect URI is exactly
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Its client secret is stored
  only in Cloudflare, and its expiry date is noted.
- Named admins: the Access policy includes only the listed administrators' Entra accounts, or
  one Entra group holding only them. Never "Everyone" or a whole email domain.
- MFA: a Conditional Access policy for that enterprise application requires MFA (or Security
  defaults, without Entra ID P1). Proof: after one sign-in through Access, Entra > Sign-in logs
  for that sign-in shows "Authentication requirement: Multifactor authentication".
- One-time PIN is OFF for the admin applications.

### 7.3 First real Cloudflare test on QA (admin-qa.eticketsgo.com), before any production step

| #   | Action                                                                                                                                                               | Expected                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Set `ADMIN_ACCESS_GATE=report`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (the QA application's tag) on QA admin-web with skipDeploys; redeploy its current commit | Boot log `admin_access_gate` with `mode: report`, `configured: true`                                                         |
| 2   | Open admin-qa in a private window                                                                                                                                    | Cloudflare login, then Entra sign-in with an MFA prompt, then the console's own sign-in page                                 |
| 3   | Sign in to the console (password + TOTP), open a few pages, perform one step-up action                                                                               | Works. The logs show no `admin_access_gate_would_refuse` for this session: the Cloudflare-issued JWT validates at the origin |
| 4   | Sign in to Cloudflare with an Entra account that is NOT in the policy                                                                                                | Cloudflare denies; the request never reaches Railway                                                                         |
| 5   | `curl https://admin-web-qa.up.railway.app/login` (the direct Railway name)                                                                                           | Logged as `would_refuse` (`no-token`)                                                                                        |
| 6   | Switch to `enforce` and redeploy the same commit                                                                                                                     | Steps 2-3 still work; step 5 answers 403; `/api/health` on the Railway name answers 200; the deployment is healthy           |
| 7   | Invite a test staff member who is in the policy; open the invite link                                                                                                | Cloudflare sign-in, then the invite page                                                                                     |
| 8   | Leave QA in `enforce` for a working day; read the logs                                                                                                               | No refusals of real sessions                                                                                                 |

Only after all eight: the production steps in section 4, each with approval.

### 7.4 Rollback

| What went wrong                                          | Fastest safe rollback                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admins refused by the gate                               | `ADMIN_ACCESS_GATE=report` (or `off`) on admin-web and redeploy the same commit. The console's own sign-in, MFA and roles still protect it                                                                                                                                                                          |
| Cloudflare Access or Entra outage                        | Same as above; optionally turn the Access application off in Zero Trust                                                                                                                                                                                                                                             |
| One proxied name misbehaves (certificate, redirect loop) | In Cloudflare, switch that record to DNS only (grey cloud): it goes straight to Railway again within the TTL                                                                                                                                                                                                        |
| The zone move itself (mail, many names)                  | Set the nameservers back to `ns05.domaincontrol.com` / `ns06.domaincontrol.com` at GoDaddy. Do not delete or edit the GoDaddy zone until Cloudflare has run cleanly for two weeks: that untouched zone is the rollback. Propagation can take up to 48 h, which is why 7.1 lowers TTLs first and keeps mail DNS only |
