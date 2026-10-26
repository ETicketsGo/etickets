# Identity journeys: sign-in, onboarding and console access

Status: implemented on branch `feat/organizer-identity-journey` (from `origin/main` 68fe4907).
Not merged, not deployed. Line numbers marked `@68fe4907` are on the base commit, before this
branch; all others are on this branch.

Update (2026-10-26): the two security findings in section 7 (team invitations, suspended
organizations) were decided by the owner and are FIXED on the stacked branch
`fix/invite-and-suspension-security`. See sections 2.6 and 2.7, the tests in section 4, QA
steps 16 to 27 in section 5, and the migration in section 6.

Owner evidence (production, 2026-10-25):

1. `https://eticketsgo.com/register?intent=organizer` answered GoDaddy's 404.
   `https://www.eticketsgo.com/register?intent=organizer` answered 200.
2. A phone-registered customer (mobile number only, no email, no password) became an organizer
   on the storefront. The account menu showed "Organizer console - DeepTrics Idaho", and the link
   opened `organizer.eticketsgo.com/login`, which offered only email and password.

## 1. Root causes

### 1.1 The bare-apex link

`apps/organizer-web/lib/storefront-url.ts:29@68fe4907` worked out the storefront address by
removing `organizer.` from the console's host. In production that left `eticketsgo.com`. The
bare apex is a registrar forwarder that answers every path with a 404. Both links under the
console sign-in card used it: "Forgot your password?" and "Create an organizer account".
The unit test pinned the broken value (`storefront-url.test.ts:14@68fe4907`), so CI stayed green.

Fix: a derived host with no subdomain of its own now gets `www.` in front (`servedHost`). The QA
and UAT mappings and the `NEXT_PUBLIC_STOREFRONT_URL` override do not change.

A search of every app found these other places that build the bare apex:

| Where                                                   | What                                                                                                                                | Fix                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/customer-web/Dockerfile:17@68fe4907`              | `ARG NEXT_PUBLIC_SITE_URL=https://eticketsgo.com`. A build without the argument puts the apex into share and invite links           | Default is now `https://www.eticketsgo.com`                                                                                     |
| `deploy/railway/env/production.env.example`             | `CUSTOMER_WEB_URL`, `NEXT_PUBLIC_SITE_URL`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` and `RAZORPAY_CALLBACK_URL` all used the apex | All now use www                                                                                                                 |
| API boot (`apps/api/src/common/email-host-warnings.ts`) | Nothing reported a production `CUSTOMER_WEB_URL` (reset, booking and invitation links) or a buyer return URL set to the apex        | Each one is now named at boot with the www value it should hold. Nothing is rewritten, following the existing rule in that file |

These hits are harmless and stay as they are: `sign-in-return.ts:62` and
`admin-console-url.ts:25` resolve to `admin.eticketsgo.com`. The mobile
`become-organizer.ts:27` resolves to `organizer.eticketsgo.com`. `CORS_ORIGINS` is an
allow-list, not a link.

**The owner must check (no access from here):** that `CUSTOMER_WEB_URL` on the production api
**and** worker, and `NEXT_PUBLIC_SITE_URL` on production customer-web, are
`https://www.eticketsgo.com`. The next API boot names any that are not.

### 1.2 A phone-only organizer cannot reach the console

Three gaps, one after the other:

1. **Separate origins, separate sessions.** Tokens live in each origin's `localStorage`
   (`packages/web-kit/src/api.ts`, `etg_access` / `etg_refresh`). A storefront session is not
   visible to `organizer.eticketsgo.com`. This is by design and it stays.
2. **The console had one way in: email and password** (`packages/web-kit/src/login.tsx:283@68fe4907`).
   A phone-only account has a placeholder email (`phone+<digits>@users.eticketsgo.internal`) and
   a placeholder password hash. Neither can be typed.
3. **The storefront link was a plain link to the console**:
   `components/account-menu.tsx:196@68fe4907` (`${ORGANIZER_URL}/organizer`) and the
   become-organizer page (`:114@68fe4907`, `${ORGANIZER_URL}/login?email=`). The copy said
   "Enter your password again" (`separateSignIn`), which assumes a password exists.

The organization membership was valid on the server the whole time. Only the way in was missing.

## 2. What changed

### 2.1 Phone sign-in on the organizer console (outcome B)

The console sign-in card now has **Email | Mobile** tabs (`LoginForm` `phoneSignIn`;
`packages/web-kit/src/phone-sign-in.tsx`). Email and password work as before.

- It uses the same API routes as the storefront: `POST /auth/phone/request-code` and
  `POST /auth/phone/verify`. Both keep the same `@RequiresHumanCheck('otp')` (Turnstile, answered
  by the existing `HumanCheckProvider`), the same `AUTH_THROTTLE` and the same per-number OTP
  guard (60 s cooldown, hourly and daily caps). The answers stay the same and do not depend on
  whether the number has an account.
- Country picker, "Send a new code" and "Change number" work as on the storefront. The phone
  parser moved to `packages/web-kit/src/phone-number.ts`, and the storefront re-exports it.
- **Back-office accounts:** the API still answers a second-factor challenge
  (`signInOrChallenge`). The storefront refuses that challenge (`refuseChallenge`). The console
  now completes it on the same card with the authenticator or a recovery code, exactly as the
  password form does (`api.auth.verifyPhoneCodeOrChallenge`). The phone route therefore cannot be
  used to skip the second factor.
- If no text message can be sent (SMS off, or `phoneSignInCountries` empty, as on QA in log
  mode), the Mobile tab is hidden or explains why and offers email.

### 2.2 Storefront-to-console handoff, with no token in any URL (outcome C)

New routes in `apps/api/src/auth/auth.controller.ts`, logic in `auth/handoff.service.ts`:

| Step | Route                                                                | Rules                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /auth/handoff` `{audience:"organizer"}` (needs a session)      | Reads the account and its seats from the **database**, not the token. The account must be ACTIVE and hold an ACTIVE `ORGANIZER_OWNER` / `ORGANIZER_MANAGER` / `CHECKIN_STAFF` seat in an organization that is not SUSPENDED. Returns `{code, expiresInSeconds: 60}` and nothing else                                                                                                    |
| 2    | Browser goes to `https://<console>/handoff#code=<code>`              | The code is in the **fragment**. Fragments are never sent to a server or in a Referer header. The console's first action is `history.replaceState` to remove it from the address bar and from history (`apps/organizer-web/lib/handoff.ts`)                                                                                                                                             |
| 3    | `POST /auth/handoff/exchange` `{audience, code}` (public, throttled) | One conditional `UPDATE ... WHERE consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`, so exactly one exchange wins. Checks the account and seat again. Then runs the same `signInOrChallenge` gate as every sign-in: a new refresh token under the normal rotation rules, or for a back-office account the MFA challenge (completed on the console card) and **no tokens** |

Storage: `AuthHandoff` table. It holds the SHA-256 of a 32-byte random code (the code itself is
never stored), the audience, `expiresAt` (60 s), `consumedAt`, `revokedAt` and the requesting IP.

These cases are refused with one public answer each. The audit log records the reason
(`AUTH_HANDOFF_CREATED`, `AUTH_HANDOFF_EXCHANGED`, `AUTH_HANDOFF_REFUSED` with
`metadata.reason`):

- unknown code (`unknown`)
- expired (`expired`)
- reused (`reused`)
- revoked by sign-out (`revoked`)
- wrong audience (`wrong_audience`)
- no seat (`no_membership`)
- only suspended organizations (`organization_suspended`)
- account suspended or deleted (`inactive_user`)

Entry points that now use the handoff:

- Storefront account menu, "Organizer console - <organization>".
- Become-organizer page, "Open the organizer console". It now reads "You do not need to sign in
  again".
- Console sign-in, "Continue with your ETicketsGo account". This links to the storefront's
  `/account/organizer-console`. If you are signed in there, it mints a code and comes straight
  back with `location.replace`. If not, it asks you to sign in on the storefront first. It only
  ever goes to the configured console origin, so it is not an open redirect.

If no code can be made, the link opens the console sign-in page, which now offers phone and
email. The `href` of each link is the console sign-in page, for a new tab or a browser without
script.

**Why this is safe:**

- A code is not a token. It cannot call any API, it lives 60 seconds, it works once, and it is
  only for one audience.
- It travels in a fragment that the console deletes from history before it uses it.
- Minting it needs a valid session, plus a database check of the seat at mint time and again at
  exchange time.
- The exchange cannot skip MFA, and it creates an ordinary refresh-token family on the console.
- Tests check that the mint reply holds no JWT-shaped string and that the navigation URL holds
  no JWT and no query string.

### 2.3 An email for organizer messages (outcome D)

Before this change, a phone-only organizer received nothing by email. `notifyOrganizationOwners`
sends to the owner's **account** email, and the email channel skips a placeholder address
(`notifications/channels/email.channel.ts`). The organization's own `contactEmail` is the public
support address that customers see. It was optional and never verified, and nothing sends the
organizer messages there. So it could not be used for this.

There was no existing email verification flow. This branch adds one
(`auth/email-verification.service.ts`):

- `POST /auth/email/request-code` and `POST /auth/email/verify` need a session. The account comes
  from the token. Both are throttled, and request-code is human-checked.
- Only for an account whose email is still the placeholder.
- The 6-digit code is stored as a bcrypt hash. It allows 5 guesses (each guess is claimed
  before it is checked), lives 10 minutes, and asking again kills the last code.
- It is sent straight through `EmailChannel`, never `NotificationService`, so the live code is
  never a `Notification` row.
- In a deployed environment whose email provider is `log`, nothing is sent. The person is told
  "We can't send email right now" and the code is spent. This is the same rule as the SMS code.
  **Production email is still log-mode (see the PROD notifications memo), so in production this
  step will say that until SES is configured.** The step can be skipped, so onboarding never
  blocks on it.
- On success, the address becomes `User.email` and `User.emailVerifiedAt` is set. The
  organization's `contactEmail` is filled only where it was empty.
- **No password is asked for or set.** The person still signs in by phone. The proved address
  now also works for "Forgot password", which is a deliberate new recovery path.
- The duplicate rule is unchanged. An address that already has an account is refused with the
  same `EMAIL_ALREADY_REGISTERED` answer that sign-up gives.

UI: `components/organizer-email-step.tsx` appears on the become-organizer "ready" screen for a
phone-only account, and on the profile for a phone-only organizer.

### 2.4 Server authorization (outcome E): confirmed, now tested end to end

- Every organizer route checks membership in the database (`OrgAccessService.assertMember`:
  ACTIVE seat, allowed role). Platform staff without a seat need a named capability.
  `JwtStrategy` reads roles and status from the database on every request.
- The new HTTP test proves that a customer with a **valid** session and no seat gets **403** on
  `GET /organizations/:id`, `/members` and `/actions`, and `[]` from `GET /organizations`.
- A suspended **account** gets 401 on every route (its token stops working) and nothing from
  sign-in or the handoff.
- A suspended **organization** is refused the handoff, and (since 2.7) every organizer API too:
  `assertMember` answers 403 `ORGANIZATION_SUSPENDED` for it, whatever made the session.

### 2.5 Recovery, sign-out and multi-role (outcome F)

- **Forgot password from the console** now goes to `https://www.eticketsgo.com/forgot-password`
  in production (section 1.1).
- **Storefront sign-out now ends the session on the server.** `useSignOut`
  (`apps/customer-web/lib/use-shell-auth.ts:48@68fe4907`) only cleared the browser. The refresh
  token stayed valid until it expired, and so would any handoff code. It now calls
  `POST /auth/logout`, which revokes the refresh token **and every outstanding handoff code for
  that account**. It also clears the React Query cache, so the next person on a shared device
  does not see the last person's name and organization in the menu.
- `POST /auth/logout-all` and a password reset also revoke handoff codes.
- **Sign out everywhere:** the API supported it and nothing offered it. The storefront profile
  now has "Sign out on all devices".
- **Cross-domain sign-out works like this.** Each origin (storefront, organizer console, admin
  console, Android app) holds its own tokens. Signing out on one origin revokes that origin's
  refresh token only. The other origins stay signed in until their own sign-out, or until
  "Sign out on all devices". Their access tokens (15 minutes) cannot be revoked and simply run
  out, and they can no longer be refreshed. A handoff cannot outlive the sign-out of the session
  that asked for it.

### 2.6 Team invitations: only the invited person accepts (owner decision 1, FIXED)

Root cause. `acceptInvitation` (`organizations.service.ts:734-801@6fbaa314`) took the token and
nothing else. The route was `@Public`, so for an EXISTING account the link alone made it an
ACTIVE member; for an account the invitation created, the link alone set its password. And
`inviteMember` / `resendInvitation` returned `inviteUrl` to the inviting owner, and the console
showed it to copy (no email was sent at all). So an owner could add any existing account to
their organization without that person, or choose a new colleague's password and sign in as
them. The back-office staff invite had the same shape (`admin-staff.service.ts:243-253@6fbaa314`).

What changed:

- **The link reaches the invitee only.** `issueInvitation` emails it (new
  `NotificationType.TEAM_INVITATION`, straight through the email channel, never stored in a
  Notification row) and returns only `invitationEmail: 'SENT' | 'NOT_SENT'`. No response carries
  the token or URL: `POST /organizations/:id/members`, `.../resend-invite` and
  `POST /admin/staff/invite`. There is no test-mode switch to bring it back; tests read the link
  from the email channel, as the invitee does. The console shows "Invitation sent to X" or "We
  could not email X" and offers "Send invitation again".
- **Accepting needs the invited account's own session.** `POST /public/invitations/:token/accept`
  is no longer `@Public` and takes no body. The service refuses:
  - no session: 401;
  - a session of any other account (the inviting owner, another member, a stranger): 403
    `INVITATION_WRONG_ACCOUNT` (session user id must equal the invited user, and the emails must
    match case-insensitively);
  - an account whose email is not proved (`emailVerifiedAt` null): 403 `EMAIL_NOT_VERIFIED`.
    The person proves it with the email-code flow from 2.3, for the address the account already
    has: `POST /auth/email/confirm/request-code` then `POST /auth/email/confirm/verify` (same
    hashed 6-digit code, 10 minutes, 5 guesses, 1 a minute and 5 an hour, human check, throttle).
  - a used, expired or withdrawn link: 404 / 409, as before.
- **An account the invitation created is CLAIMED first, with a code sent to the invited address.**
  `POST /public/invitations/:token/account/request-code` (public, human check, throttle) sends the
  code; `POST /public/invitations/:token/account` (code, name, password) proves the mailbox, sets
  the password and `emailVerifiedAt`. Claiming does NOT join the team: the person then signs in
  with that password and accepts like anybody else. For a back-office invitation (no team to
  join, duties granted when sent) the claim is the acceptance.
- **Single use under concurrency, expiry, revocation.** Tokens were already SHA-256 at rest. The
  accept is now a guarded `updateMany` (`acceptedAt`, `revokedAt` null, not expired), so two
  accepts with one link cannot both win. A resend replaces the hash (old link dead). Removing a
  pending member (cancel) sets the new `AccountInvitation.revokedAt` and rotates the hash.
- **Audit.** `MEMBER_INVITE_ACCEPTED` (`via: session`, `emailVerified: true`),
  `MEMBER_INVITE_REFUSED` with `metadata.reason` (`wrong_account`, `email_not_verified`,
  `invalid_or_used`, `expired`, `withdrawn`), `INVITED_ACCOUNT_CLAIMED`,
  `BACK_OFFICE_INVITE_ACCEPTED`, `ACCOUNT_EMAIL_CONFIRMED`, `ACCOUNT_EMAIL_CODE_SENT`
  (`metadata.purpose`).
- **Duplicate accounts.** `inviteMember` looks the address up case-insensitively, so an
  invitation to `asha@x.com` reaches the account registered as `Asha@x.com` instead of creating
  a second one.

UI: `apps/organizer-web/components/invite-acceptance.tsx` (the invite page): signed out, an
existing account gets the console sign-in (email or mobile) and comes back to the page; a new
account gets "Send me a code", then code, name and password, then is signed in and joined;
signed in, "Accept invitation", with the confirm-email step or "You are signed in with a
different account ... Sign out" when the API says so. `apps/admin-web/app/invite/[token]`: the
claim flow, then the admin sign-in (and its MFA enrolment, unchanged).

### 2.7 Suspended organizations: no console by any route (owner decision 2, FIXED)

Root cause. `OrgAccessService.assertMember` (`tenancy/org-access.service.ts:84-112@6fbaa314`)
checked the seat (ACTIVE, role) and never the organization's status. Suspension only stopped
selling, payouts and auto-approval; the handoff refused it, but password and phone sign-in, and
any session or refresh token already held, kept the whole organizer API.

What changed:

- `assertMember` reads the organization's status with the seat (one query). An ACTIVE member of
  a SUSPENDED organization gets **403 `ORGANIZATION_SUSPENDED`** (details: `organizationId`,
  `organizationName`) on every organizer route, whatever the role and however the session was
  made. It is re-read per call, so a token minted before the suspension is refused on its next
  request, and so is one refreshed after it.
- **Staff cannot use a seat to bypass it.** A platform admin who holds a seat in the suspended
  organization falls through to the staff path: the named capability (for example
  `ORGANIZER_READ` on `GET /organizations/:id`), audited `PLATFORM_ORGANIZER_ACCESS_*`. Staff
  with no seat are unchanged. The `/admin/organizers` routes (view, suspend, reinstate) never
  call `assertMember` and are unchanged.
- `managedOrganizationIds` leaves suspended organizations out. `GET /organizations` still LISTS
  them, as `{ id, name, slug, status: 'SUSPENDED', myRole }` only (no counts, contact, legal or
  payout fields), so the console can say what happened.
- Sign-in is unchanged: password and phone still succeed (a customer identity), and buying
  tickets is unaffected. Public event pages keep the existing rule (sales stop). The handoff
  keeps refusing a member whose only organizations are suspended.
- **A member of several organizations keeps the others.** Only the suspended one is refused.

UI: `apps/organizer-web/app/organizer/layout.tsx` `SuspensionGate`. When every organization the
person belongs to is suspended, the console renders only
`components/suspended-organization.tsx`: "This organization is suspended", a message box that
sends a support request (`POST /support`, kind CONTACT, filed under the organization), a link to
the storefront contact page (`<storefront>/contact`, from `storefrontOrigin`), and Sign out - no
navigation. Otherwise suspended organizations are simply not offered (switcher, masthead). Any
`ORGANIZATION_SUSPENDED` answer while the console is open re-reads the organization list.

## 3. Entry-point inventory (outcome A)

B = behaviour now. D = defect found (fixed here unless marked OPEN).

### 3.1 Storefront (`apps/customer-web`, `app/[locale]/...`)

| Entry point                                  | Where                                        | Behaviour / defects                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in, email                               | `login/page.tsx:65-84`                       | B: password. A back-office account gets a link to the admin console. D OPEN: `/login?reset=1` from reset-password is never read, so there is no "password changed" notice                                                                           |
| Sign in, phone                               | `components/phone-sign-in.tsx:163-190`       | B: code, `isNewAccount` handled. D OPEN (minor): a back-office phone sign-in shows only the MFA_REQUIRED sentence, with no admin-console link                                                                                                       |
| Sign up (email / phone), `?intent=organizer` | `register/page.tsx:39,124-137`               | B: organizer intent goes to become-organizer. D OPEN: on the "already registered" path the organizer intent is lost. D OPEN: a signed-in visitor who clicks "Start selling" (marketing pages) is shown the sign-up form instead of become-organizer |
| Forgot password                              | `forgot-password/page.tsx:34-49`             | B: one fixed answer. D OPEN: every error, including a 500, shows "sent". Email only: a phone-only account recovers by phone code, and now also by email once it adds one (2.3)                                                                      |
| Reset password                               | `reset-password/page.tsx:40-70`              | B: revokes all sessions and handoff codes. D OPEN: always ends on the storefront login, with no way back to the console                                                                                                                             |
| Ticket invite                                | `invite/[token]`                             | B: needs sign-in. This is not a team invitation                                                                                                                                                                                                     |
| Account pages guard                          | each page, for example `account/page.tsx:40` | B: a client-side redirect to `/login?next=`. D OPEN: `account/notifications` has no guard (it shows "could not load"). D OPEN (likely): `sign-in-required.tsx` builds `next` with the locale prefix included                                        |
| Profile                                      | `account/profile/page.tsx`                   | B: name, phone attach, residence. **New:** "Sign out on all devices", and the email step for phone-only organizers                                                                                                                                  |
| Become an organizer                          | `account/become-organizer/page.tsx`          | B: creates the organization, refreshes the token. **Changed:** console link uses the handoff, new copy, email step. D OPEN: if the refresh fails after the organization is created, the page reports a failure                                      |
| Open console (new)                           | `account/organizer-console/page.tsx`         | The target of "Continue with your ETicketsGo account". Handoff, then `location.replace`                                                                                                                                                             |
| Account menu                                 | `components/account-menu.tsx`                | **Changed:** "Organizer console" uses the handoff (2.2)                                                                                                                                                                                             |
| Sign out                                     | `lib/use-shell-auth.ts`                      | **Fixed:** server revoke and cache clear (2.5)                                                                                                                                                                                                      |
| Links to the console                         | `lib/organizer-console.ts`                   | One source (`NEXT_PUBLIC_ORGANIZER_URL`). D OPEN: falls back to `http://localhost:3001` when the build variable is missing (the Dockerfile ARG has the same default; `verify:deploy` checks it)                                                     |

### 3.2 Organizer console (`apps/organizer-web`)

| Entry point     | Where                                                          | Behaviour / defects                                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in         | `app/login/page.tsx`                                           | **Changed:** Email and Mobile tabs, "Continue with your ETicketsGo account", www storefront links                                                                                                                                                   |
| Handoff (new)   | `app/handoff/page.tsx`                                         | Strips the fragment, exchanges the code, completes MFA on the card, goes to `/organizer` (`/back-office` for staff)                                                                                                                                 |
| `/start`        | `app/start/page.tsx`                                           | B: a signed-in account with no seat creates an organization. D OPEN: `ORGANIZER_ROLES` leaves out CHECKIN_STAFF and counts a leftover global ORGANIZER_OWNER role, so a removed member is told "You are all set" and lands on "No organization yet" |
| Team invitation | `app/invite/[token]/page.tsx`                                  | **Fixed (2.6):** sign in as the invited address (or claim a new account with an emailed code), confirm the email, then accept with the session                                                                                                      |
| `/back-office`  | `app/back-office/page.tsx`                                     | B: an administrator chooses between the admin console and the organization                                                                                                                                                                          |
| Guard           | `app/organizer/layout.tsx:143-168`, `web-kit hooks.tsx:47-107` | B: signed-out users go to `/login?next=`. D OPEN: the query is dropped from `next`. The role check is skipped if `/auth/me` fails (the API still enforces)                                                                                          |
| Sign out        | `web-kit useLogout`                                            | B: server revoke, cache clear                                                                                                                                                                                                                       |

### 3.3 Admin console (`apps/admin-web`)

| Entry point     | Behaviour / defects                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in + MFA   | `app/login/page.tsx`: `LoginForm` with `mfaEnrollPath`. **Unchanged.** Admin MFA works as before. The phone tab is not enabled on the admin console |
| Enroll MFA      | `app/enroll-mfa/page.tsx`. Unchanged                                                                                                                |
| Guards          | `RequireAuth` + `MfaGate`. D OPEN (minor): `MfaGate` clears tokens without calling `/auth/logout`                                                   |
| Forgot password | D OPEN: there is no link on the admin sign-in page                                                                                                  |

### 3.4 Android (`apps/customer-mobile`)

| Entry point                        | Behaviour / defects                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in / sign up, phone and email | `app/(auth)/login.tsx`, `register.tsx`. Tokens in SecureStore. Sign-out calls `/auth/logout`. D OPEN: email sign-in does not handle an MFA challenge (phone sign-in does)                                                                                                                                                                           |
| Become an organizer                | `app/account/become-organizer.tsx`. Opens `organizer.eticketsgo.com/login` in the browser. **Now works for a phone-only account**, because the console offers phone sign-in. The app holds no browser session, so no handoff from the app. D OPEN: it asks only for a name and contact email (the web asks for legal name, country and entity type) |
| Links                              | `services/legal.ts` uses www. Correct                                                                                                                                                                                                                                                                                                               |

### 3.5 API

| Area             | Behaviour                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every sign-in    | Password, phone code, MFA verify and now the handoff all pass `signInOrChallenge`. Suspended and deleted accounts get nothing. Back-office accounts get the challenge            |
| Refresh          | Rotation with reuse detection, unchanged. A handoff session is an ordinary family                                                                                                |
| Organizer routes | `OrgAccessService.assertMember` checks the ACTIVE seat and (2.7) that the organization is not SUSPENDED. `JwtStrategy` refuses a removed seat's old tokens with `ACCESS_REMOVED` |
| Team invitations | **Fixed (2.6):** link emailed to the invitee only; accept needs the invited account's session and a proved email; claim needs an emailed code                                    |

### 3.6 Multi-role and incomplete profiles

- **Customer + organizer:** one account. Before this change: one sign-in per origin. Now: one
  click through the handoff, or phone or email on the console.
- **Organizer + administrator:** the handoff and phone sign-in both return the MFA challenge.
  `/back-office` offers the admin console. Admins still cannot buy on the storefront while their
  MFA is enrolled (the storefront refuses the challenge). That is unchanged.
- **Phone-only account:** what used to fail:
  - console sign-in (**fixed**)
  - console link (**fixed**)
  - no organizer email (**fixed**, opt-in)
  - forgot password (by design; recovery is the phone code)
  - a team invitation sent to a real email creates a second account (OPEN)

## 4. Tests (outcome G)

| Requirement                                                            | Test                                                                                                                | Before this branch                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production storefront maps to www                                      | `apps/organizer-web/lib/storefront-url.test.ts` "sends production to www, never to the bare apex"                   | **Failed** (committed first, 183fe56d). The old case pinned the apex                                                                                            |
| Bare apex named at boot                                                | `apps/api/src/common/email-host-warnings.spec.ts` (2 new)                                                           | Failed (no such warning)                                                                                                                                        |
| Phone-only user signs in by phone and opens their organization         | `organizer-handoff.http.integration-postgres.spec.ts` case 1. UI: `packages/web-kit/src/phone-sign-in.test.tsx` (3) | The console had no phone path                                                                                                                                   |
| Handoff happy path, hashed, 60 s, single use, refresh rotation works   | integration case 2                                                                                                  | Routes did not exist                                                                                                                                            |
| Reuse refused                                                          | case 2                                                                                                              | n/a                                                                                                                                                             |
| Expiry refused                                                         | case 3                                                                                                              | n/a                                                                                                                                                             |
| Sign-out / sign-out-everywhere revoke a code in flight                 | cases 4, 5. Unit: `auth.service.spec.ts` (2 new)                                                                    | n/a                                                                                                                                                             |
| Malformed / unknown / wrong audience                                   | case 6                                                                                                              | n/a                                                                                                                                                             |
| Non-member: handoff 403 **and** organizer API 403 with a valid session | case 7                                                                                                              | API 403 already held. Now proven over HTTP                                                                                                                      |
| Suspended organization refused                                         | case 8                                                                                                              | n/a                                                                                                                                                             |
| Removed seat between mint and exchange                                 | case 9                                                                                                              | n/a                                                                                                                                                             |
| Suspended account: exchange 401, token 401                             | case 10                                                                                                             | n/a                                                                                                                                                             |
| MFA user gets the challenge, never tokens, no refresh row              | case 11                                                                                                             | n/a                                                                                                                                                             |
| Email collection and verification, no password, org contact filled     | cases 12, 13                                                                                                        | n/a                                                                                                                                                             |
| No token in the navigation URL (fragment only, no query, no JWT)       | `apps/customer-web/lib/organizer-console.test.ts`, `apps/organizer-web/lib/handoff.test.ts`                         | n/a                                                                                                                                                             |
| New routes throttled; organizer route policy lists them                | `auth-throttle.spec.ts` (enumerates the controller), `organizer-route-policy.spec.ts`                               | Fails if a route is added without a throttle or policy                                                                                                          |
| App boots                                                              | `app-module-graph.integration-postgres.spec.ts`                                                                     | The first version had a circular import between AuthService and the handoff service. Nest could not resolve it, and the integration run caught it before commit |

**Owner decisions 1 and 2 (branch `fix/invite-and-suspension-security`).** The reproduction was
committed first (97acbf77) and failed against the old code: accept with no session answered
201, the inviter's response carried `inviteUrl`, and suspended-org members got 200 from
organizer APIs.

| Requirement                                                                                                                                                                                          | Test                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Inviter response holds no token or URL; the email goes to the invitee only                                                                                                                           | `organizations/invite-and-suspension.http.integration-postgres.spec.ts` case 1; `team-invitations` spec |
| Accept with no session refused (401), member stays INVITED                                                                                                                                           | HTTP case 2                                                                                             |
| Accept by the inviting owner's session refused (403 INVITATION_WRONG_ACCOUNT, audited `wrong_account`)                                                                                               | HTTP case 3                                                                                             |
| Accept by another member's or a stranger's session refused                                                                                                                                           | HTTP case 4                                                                                             |
| Unverified email must be confirmed by code first; then member ACTIVE, invitation accepted, audit row                                                                                                 | HTTP case 5; `team-invitations` spec                                                                    |
| Verified account joins in one step                                                                                                                                                                   | HTTP case 6                                                                                             |
| Expired, reused, resent (old link) and cancelled links refused                                                                                                                                       | HTTP cases 5, 7, 8; `team-invitations` spec                                                             |
| New address: link alone cannot set a password; wrong code sets nothing; claim, sign in, accept                                                                                                       | HTTP case 9; `team-invitations` spec; back-office claim in `team-invitations` spec                      |
| Suspended org: password, phone, pre-suspension refresh token and pre-suspension access token all get 403 ORGANIZATION_SUSPENDED on org, members, events list, orders, payouts, analytics, and invite | HTTP cases 11-13                                                                                        |
| Handoff still refused for a suspended-only member                                                                                                                                                    | HTTP case 14                                                                                            |
| List shows a suspended org by name and status only                                                                                                                                                   | HTTP case 15; `organization-console-reads.spec.ts`                                                      |
| Multi-org member keeps the other organization (API and handoff)                                                                                                                                      | HTTP case 16                                                                                            |
| Sign-in works and the person can still buy a ticket                                                                                                                                                  | HTTP case 17                                                                                            |
| Staff with ORGANIZER_READ still read a suspended org; a staff seat does not bypass; reinstating restores access                                                                                      | HTTP case 18; `org-access.service.spec.ts` (5 new)                                                      |
| Suspended screen: title, contact link, no nav, sign out, appeal posted                                                                                                                               | `apps/organizer-web/components/suspended-organization.test.tsx`, `lib/suspension.test.ts`               |
| Invite page: sign-in prompt, confirm-email step, wrong account, new-account claim                                                                                                                    | `apps/organizer-web/components/invite-acceptance.test.tsx`                                              |
| New routes listed with a staff policy                                                                                                                                                                | `organizer-route-policy.spec.ts`                                                                        |

Runs on this branch: see the PR description for exact counts.

**Local browser walk (Playwright, Chromium, 1280 px and 390 px).** The built API ran on :4100
against a seeded throwaway database, with customer-web on :3100 and organizer-web on :3101. These
are not the owner's ports. Results:

- A phone-only owner signed in on the storefront, clicked "Open the organizer console" and
  landed on `/organizer` of their organization, signed in.
- The navigation list held `/handoff#code=...` only as a fragment. The HTTP request for
  `/handoff` carried no code. No URL held a JWT. The final address bar was `/organizer`.
- Phone sign-in on the console (Mobile tab, US, code) ended on `/organizer`.
- On the console, "Continue with your ETicketsGo account" went to the storefront's
  `/account/organizer-console`, then `/handoff`, then `/organizer`.
- Replaying the spent `/handoff#code=` URL showed "This sign-in link has expired or was already
  used..." and the address bar was `/handoff` with no code.
- The per-number 60-second resend cooldown applied between the two widths, as designed.

## 5. QA certification checklist (outcome H)

Run on QA after merge and deploy. Do every journey at **desktop (1280 px)** and **phone
(390 px)** widths. Screenshot each final state. A green API answer is not a pass. Walk the
journey (see `pass-means-the-journey-works`).

Note: QA SMS is in log mode, so the console's Mobile tab is hidden there (no country can receive
a code). Phone sign-in on the console can only be walked where SMS is live, or by reading the code
from the QA API log while `messageContentLoggable` allows it. That is LOCAL/DEV only, so on QA
the phone tab being **hidden, with the reason given**, is the expected result.

| #   | Journey                                                                                                           | Expected                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Existing phone-only customer: storefront, account menu, Become an organizer, create, "Open the organizer console" | Lands on `organizer-qa.../organizer`, signed in, organization shown. Address bar never shows `#code=` after load. Back button does not return a code                                   |
| 2   | Same account: storefront account menu, "Organizer console - <org>"                                                | Same as 1                                                                                                                                                                              |
| 3   | Console sign-in, Mobile tab (where SMS works)                                                                     | Code, verify, `/organizer`. "Send a new code" and "Change number" work. A wrong code gives the generic error                                                                           |
| 4   | Email organizer (email + password) on the console                                                                 | Unchanged                                                                                                                                                                              |
| 5   | Invited organizer: see steps 16 to 23                                                                             | Replaced by the invitation steps below                                                                                                                                                 |
| 6   | Returning organizer signed in on the storefront: console sign-in, "Continue with your ETicketsGo account"         | Storefront `/account/organizer-console`, then back to the console signed in. Signed out on the storefront: storefront sign-in first, then back                                         |
| 7   | Suspended organization (suspend in admin): storefront "Organizer console"                                         | Falls back to the console sign-in. `/account/organizer-console` shows "Your organization is suspended. Contact support for help." See also steps 24 to 27                              |
| 8   | Expired handoff: copy a `/handoff#code=` URL from devtools before load, wait 61 s, open it                        | "This sign-in link has expired or was already used..." with a Sign in button                                                                                                           |
| 9   | Reused handoff: open the same URL again after a success                                                           | Same refusal                                                                                                                                                                           |
| 10  | Non-member customer: `/account/organizer-console`                                                                 | "This account is not on an organizer team yet..." with "Become an organizer"                                                                                                           |
| 11  | Admin MFA: admin@ on admin-qa sign-in                                                                             | MFA challenge as before. Admin who is also an organization member, via handoff: console asks for the authenticator code, then `/back-office`                                           |
| 12  | Phone-only organizer email step (QA email = SES?)                                                                 | With SES: code arrives, confirm, profile shows the email, the organization contact email is filled. Without SES (log): "We can't send email right now", "Do this later" works          |
| 13  | Storefront "Sign out", then open a handoff URL minted just before                                                 | Refused (`revoked`)                                                                                                                                                                    |
| 14  | Profile, "Sign out on all devices"                                                                                | Storefront signed out. Console tab's next refresh fails, then console sign-in                                                                                                          |
| 15  | Production link check (read-only, no sign-in): `curl -sI https://organizer.eticketsgo.com/login` then load it     | "Create an organizer account" goes to `https://www.eticketsgo.com/register?intent=organizer` (200). "Forgot your password?" goes to `https://www.eticketsgo.com/forgot-password` (200) |

**Team invitations (2.6).** QA email must be a real provider for steps 16 to 21; with `log`
the console must say "We could not email ..." (step 22). Use two real mailboxes you control.

| #   | Journey                                                                                          | Expected                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | Owner, Team, invite an EXISTING account's address                                                | "Invitation sent to X". No link anywhere on the page. In devtools, the `POST .../members` response has no `inviteUrl` and no `/invite/`                                     |
| 17  | Same owner, still signed in: open the invite link from the invitee's mailbox in the same browser | "Accept invitation", then "You are signed in with a different account". Member still "Invitation pending". SQL: a `MEMBER_INVITE_REFUSED` row, reason `wrong_account`       |
| 18  | Sign out, open the link signed out                                                               | Sign-in card for the invited address (email or mobile). No accept without signing in                                                                                        |
| 19  | Sign in as the invitee (email not yet confirmed)                                                 | Back on the invite page. "Accept invitation" leads to "Confirm your email address first". Code arrives at that mailbox; enter it; joined, lands on `/organizer` of that org |
| 20  | Open the same link again                                                                         | "This invitation cannot be used ... may already have been used"                                                                                                             |
| 21  | Invite a brand-NEW address; open the link signed out                                             | "Send me a code", code arrives, enter code, name, password, "Create account and join"; lands in the organization                                                            |
| 22  | (QA with `log` email) invite anybody                                                             | "We could not email X". Member listed as invited. No link shown                                                                                                             |
| 23  | Owner: "Send invitation again" on a pending member, then open the FIRST email's link             | The old link is refused. The new email's link works. Removing a pending member, then opening its link: refused                                                              |

**Suspended organizations (2.7).** Suspend an organization in the admin console first (with a
reason). Use a member who signs in by password, one by phone (where SMS works), and one who
also belongs to a second, approved organization.

| #   | Journey                                                                                 | Expected                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24  | Member of only the suspended org: console sign-in (password, and phone where SMS works) | Sign-in succeeds, then "This organization is suspended": message box, "Contact ETicketsGo support" (storefront `/contact`), "Sign out". No sidebar, no organization data                                       |
| 25  | A console tab that was open before the suspension: click anything                       | The next request answers 403 `ORGANIZATION_SUSPENDED` and the tab switches to the suspended screen. Devtools: every `/organizations/<id>...`, `/events?organizationId=`, `/payouts?organizationId=` answer 403 |
| 26  | Multi-org member                                                                        | Console opens on the approved organization. The suspended one is not in the switcher                                                                                                                           |
| 27  | Admin: view the suspended organizer, then Reinstate                                     | Admin pages work as before. After reinstating, the member's console works again on the next load. The same member can buy a ticket on the storefront throughout                                                |

### 5.1 Read-only SQL for QA

```sql
-- The account and its seats (replace the phone).
SELECT u.id, u.email, u."emailVerifiedAt", u.phone, u.status, u.roles,
       m.role, m.status AS seat, o.name, o.status AS org_status, o."contactEmail"
FROM "User" u
LEFT JOIN "OrganizationMember" m ON m."userId" = u.id
LEFT JOIN "Organization" o ON o.id = m."organizationId"
WHERE u.phone = '+1XXXXXXXXXX';

-- Handoffs for that account: never a plain code, at most 60 s, consumed or revoked once.
SELECT id, audience, "createdAt", "expiresAt", "consumedAt", "revokedAt",
       EXTRACT(EPOCH FROM ("expiresAt" - "createdAt")) AS ttl_s, length("codeHash") AS hash_len
FROM "AuthHandoff" WHERE "userId" = '<user id>' ORDER BY "createdAt" DESC LIMIT 20;

-- What happened, and why each refusal was refused.
SELECT "createdAt", action, metadata->>'reason' AS reason, metadata->>'stage' AS stage, ip
FROM "AuditLog"
WHERE "actorUserId" = '<user id>' AND action LIKE 'AUTH_HANDOFF_%'
ORDER BY "createdAt" DESC LIMIT 50;

-- Sessions the handoff created (one new family per successful exchange).
SELECT id, "createdAt", "revokedAt", "replacedByTokenId", "userAgent"
FROM "RefreshToken" WHERE "userId" = '<user id>' ORDER BY "createdAt" DESC LIMIT 20;

-- Email codes: hashed, attempts counted, spent.
SELECT id, email, "createdAt", "expiresAt", "consumedAt", attempts
FROM "EmailVerificationCode" WHERE "userId" = '<user id>' ORDER BY "createdAt" DESC LIMIT 10;

-- Team invitations (2.6): never a plain token (64 hex, or 'accepted:'/'revoked:' once spent),
-- who invited whom, accepted / revoked once.
SELECT i.id, u.email AS invitee, u."emailVerifiedAt", m.status AS seat, m.role,
       i."createdAt", i."expiresAt", i."acceptedAt", i."revokedAt",
       CASE WHEN i."tokenHash" ~ '^[0-9a-f]{64}$' THEN 'live-hash' ELSE split_part(i."tokenHash", ':', 1) END AS token_state,
       inv.email AS invited_by
FROM "AccountInvitation" i
JOIN "User" u ON u.id = i."userId"
LEFT JOIN "OrganizationMember" m ON m.id = i."organizationMemberId"
JOIN "User" inv ON inv.id = i."invitedByUserId"
WHERE m."organizationId" = '<org id>' ORDER BY i."createdAt" DESC LIMIT 20;

-- Every accept and refusal, with its reason.
SELECT "createdAt", action, "actorUserId", metadata->>'reason' AS reason, metadata->>'via' AS via
FROM "AuditLog"
WHERE "organizationId" = '<org id>'
  AND action IN ('MEMBER_INVITED','MEMBER_INVITE_RESENT','MEMBER_INVITE_ACCEPTED',
                 'MEMBER_INVITE_REFUSED','INVITED_ACCOUNT_CLAIMED','MEMBER_REMOVED')
ORDER BY "createdAt" DESC LIMIT 50;

-- Suspended organizations (2.7): who is still seated in one (they get the suspended screen).
SELECT o.id, o.name, o.status, m.role, m.status AS seat, u.email, u.phone
FROM "Organization" o
JOIN "OrganizationMember" m ON m."organizationId" = o.id AND m.status = 'ACTIVE'
JOIN "User" u ON u.id = m."userId"
WHERE o.status = 'SUSPENDED' ORDER BY o.name;

-- The suspension and reinstatement on record, and staff reads of the suspended organization.
SELECT "createdAt", action, "actorUserId", metadata->>'reason' AS reason,
       metadata->>'operation' AS operation, metadata->>'result' AS result
FROM "AuditLog"
WHERE "organizationId" = '<org id>'
  AND action IN ('ORGANIZATION_SUSPENDED','ORGANIZATION_REINSTATED',
                 'PLATFORM_ORGANIZER_ACCESS_ALLOWED','PLATFORM_ORGANIZER_ACCESS_DENIED')
ORDER BY "createdAt" DESC LIMIT 50;
```

## 6. Migration

`20261026120000_auth_handoff_and_email_verification`. It is additive and backward compatible:

- two new tables (`AuthHandoff`, `EmailVerificationCode`)
- one nullable column (`User.emailVerifiedAt`) with no default and no backfill
- one new enum value (`NotificationType.EMAIL_VERIFICATION_CODE`)

The deployed API ignores all of it, and nothing must be dropped to roll back. `prisma migrate
diff` from the migrations to the schema shows no difference.

`20261026150000_team_invitation_delivery` (fix branch). Additive and backward compatible:

- one new enum value (`NotificationType.TEAM_INVITATION`), which no row holds
- one nullable column (`AccountInvitation.revokedAt`), no default, no backfill

Tokens were already hashed, so nothing moves. **Outstanding invitations keep working** (same
hash, same expiry), but only under the new rule: the invitee must sign in as the invited
address, confirm it, and accept. Links that owners copied before this change are therefore no
longer a way in for anybody else. An account an old invitation created is claimed with an
emailed code. Nothing is invalidated in bulk.

## 7. Open questions for the owner

1. ~~**Team invitations.**~~ **DECIDED and FIXED (2.6).** Only the invited person, signed in as
   the invited address with it proved, can accept; the inviter never receives the link. Evidence:
   section 4 (the reproduction failed first, then passed).
2. ~~**Suspended organizations keep console access.**~~ **DECIDED and FIXED (2.7).** No organizer
   API by any route (403 `ORGANIZATION_SUSPENDED`), a suspended screen with a support path,
   sign-in and buying unchanged. Evidence: section 4.
3. **Production email is log-mode.** The new email step answers "We can't send email right now"
   in production until SES is configured on api **and** worker.
4. **Production variables.** Confirm that `CUSTOMER_WEB_URL` (api, worker) and
   `NEXT_PUBLIC_SITE_URL` (customer-web) are `https://www.eticketsgo.com`. Also confirm
   `RAZORPAY_CALLBACK_URL` if it is set explicitly. The API now names any bare-apex value at boot.
5. **Invitations need real email where they are used.** Since the link is emailed only, an
   environment whose email provider is `log` (production today, see 3) cannot deliver team or
   back-office invitations: the console says "We could not email ..." and nobody holds a link.
   Configure SES on api and worker before inviting there.
6. **Door check-in devices of a suspended organization.** The organizer API (including the
   check-in routes, which go through `assertMember`) is closed. A check-in device already
   activated for offline use keeps its local list until it next syncs, and syncing is refused.
   Should suspension also revoke devices immediately?
7. **Phone-only invitee.** An invitation is to an email address. A person whose account is
   phone-only gets a second account for that address (section 3.6, still OPEN). Invitations to a
   phone number are not supported.
8. **Android to console.** The app opens the console in the browser, and the person signs in
   there (phone now works). A handoff from the app would need the app to mint the code and open
   `/handoff#code=` in the browser. It is easy to add if wanted.
