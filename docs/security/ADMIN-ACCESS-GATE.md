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
