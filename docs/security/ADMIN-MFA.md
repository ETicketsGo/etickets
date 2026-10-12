# Admin multi-factor authentication (TOTP)

Status: implemented on branch `feat/admin-mfa`, **not deployed**. Nothing here changes behaviour
anywhere until the owner sets `MFA_ENCRYPTION_KEY` in an environment.

Back-office accounts (`Role.ADMIN`, `Role.SUPER_ADMIN`) must prove a second factor after the
password. Customers and organizers are untouched.

## 1. What it does

| Piece | Choice |
| --- | --- |
| Factor | TOTP, RFC 6238: HMAC-SHA-1, 6 digits, 30 s step, +-1 step window. Implemented on `node:crypto` (`auth/mfa/totp.ts`, about 100 lines, pinned by the RFC test vectors). No new TOTP dependency. |
| Replay | The newest accepted 30 s step is stored per account (`lastUsedStep`). A code is accepted only for a step newer than that, through a conditional `UPDATE`, so two simultaneous submissions of one code cannot both win. |
| QR | Drawn by our own API with `qrcode`, which is already an API dependency (ticket QR). Returned as an SVG string and shown as an `<img>` data URL. The `otpauth://` URI is never sent to a third-party service. |
| Secret at rest | AES-256-GCM, key from `MFA_ENCRYPTION_KEY` (32 bytes, base64). Stored as `v1.<iv>.<tag>.<ciphertext>`; the user id is bound in as authenticated data, so a ciphertext copied to another account does not decrypt. |
| Recovery codes | 10 per set, 10 characters from an alphabet without 0/O/1/I, shown once as `XXXXX-XXXXX`. Stored as bcrypt (cost 10) hashes, single use, regenerating replaces the whole set. |
| Lockout | 5 wrong codes (TOTP or recovery, one shared counter) lock the account for 15 minutes; the right code is refused during the lock. Per-IP: the same 10 requests/minute throttle as every credential route on `verify`, `enroll/start`, `enroll/confirm`, `step-up`. |
| Step-up | Sensitive actions also need a second-factor check made in the last `MFA_STEPUP_MINUTES` (default 10). |

## 2. Flows

**Sign-in, enrolled account.** `POST /auth/login` (or the phone-code route) answers with
`{ mfaRequired: true, challengeToken, methods }` and **no tokens**. The challenge is a 5 minute JWT
signed with a key *derived* from the access secret (HMAC with a fixed label), so it cannot be used as
an access token and an access token cannot be used as a challenge.
`POST /auth/mfa/verify { challengeToken, code | recoveryCode }` returns the normal token pair, with
claims `amr` (`["pwd","otp"]` or `["pwd","rcv"]`), `mfaCid` (the authenticator it passed against)
and `mfaAt` (epoch seconds).

**Sign-in, administrator not enrolled yet (the migration path).** Login returns ordinary tokens
with no MFA claim. Those tokens work for exactly: `GET /auth/me`, `GET /auth/mfa/status`,
`POST /auth/mfa/enroll/start`, `POST /auth/mfa/enroll/confirm`, and the public sign-out. Every other
authenticated route answers `403 MFA_REQUIRED`.

**Enrollment.** `enroll/start` needs the account **password again** (so a stolen bare session cannot
bind an attacker's phone), creates a pending credential and returns key + QR. `enroll/confirm` takes
the first code, activates the credential, issues 10 recovery codes, **revokes every existing refresh
token** (those sessions never proved a factor) and returns a verified token pair plus the codes.

**Refresh.** A new table row (`RefreshTokenMfa`) records which refresh tokens belong to a session
that passed MFA and *when*. A rotation copies that row forward unchanged. So a refresh can never
create the claim, and never refreshes the step-up clock. A refresh token with no row (anything
issued before this deploy, or by an unenrolled admin) yields an access token with no claim.

**Step-up.** `POST /auth/mfa/step-up { code | recoveryCode }` returns a new access token for the
same session carrying a fresh `mfaAt`. The admin console intercepts `MFA_STEP_UP_REQUIRED` in its
request layer, asks for a code in a dialog and repeats the call. Applied to: admin staff changes
(permissions, grant, invite, revoke, MFA reset), payout payment/failure, bank account verify /
reject / reveal, recovery-code regeneration, device replacement.

**Recovery and reset.**
- Self-service: sign in with a recovery code (works like a code, single use). From *Account
  security* the holder can make a new set of codes or *Replace my phone* (removes the authenticator
  and all sessions; the next sign-in enrolls again).
- Another super admin: `POST /admin/staff/:userId/mfa/reset` (super admin role, `ADMIN_MANAGE`,
  verified MFA session, fresh step-up). Removes the target's authenticator, recovery codes and
  sessions. **Refused for your own account.** Audited.
- Break-glass: section 6.

## 3. Where it is enforced (single point)

`apps/api/src/auth/mfa/mfa.guard.ts`, registered as a global `APP_GUARD` straight after
`JwtAuthGuard` and **before** `OrganizerOnlyGuard`, `RolesGuard` and `AdminPermissionGuard`
(`apps/api/src/app.module.ts`).

It keys on the **account**, not on decorators: if the caller holds `ADMIN` or `SUPER_ADMIN` (read from
the database by `JwtStrategy` on every request, never from the token), the session must have passed
MFA, on **every** authenticated route. Routes declared `@Roles(ADMIN...)` or `@RequiresAdmin(...)`
are a subset of that, so none can be missed, and a route added next year is covered without anyone
remembering. It fails closed: staff with no MFA state at all are refused.

`JwtStrategy.validate` decides `verified` as: the token carries `mfaCid` **and** the database has a
confirmed credential for that user **and** its id equals `mfaCid`. Deleting the credential (reset,
replace, break-glass) therefore kills every access token minted against it immediately.

Only four handlers may be called by an unverified staff session, each declared with
`@AllowMfaPending()` (see the enumeration test).

## 4. Rollout and the production administrator

Production has exactly one administrator (the owner, `SUPER_ADMIN`). The design guarantee is that
**no sequence of deploys can leave them without a way in**.

1. **Deploy this code with `MFA_ENCRYPTION_KEY` unset.** MFA is dormant: `JwtStrategy` reports
   `required: false`, the guard passes everything, login is unchanged. In STAGING/PRODUCTION/QA/UAT
   the API logs one warning that MFA is not enforced. The migration is four new tables, no existing
   column touched.
2. **Owner action: generate and store the key** (`openssl rand -base64 32`) in the managed secret
   store as `MFA_ENCRYPTION_KEY`. Redeploy.
3. **The owner signs in once.** Password works; the session is allowed to enroll only. The console
   sends them to `/enroll-mfa`: password again, scan QR, type first code, **save the 10 recovery
   codes**. They land in the console with a verified session.
4. Any open session from before step 3 is refused on admin routes (`MFA_REQUIRED`); the console
   sends it to sign-in.

Why this cannot brick the API or the owner:
- Key unset and nothing enrolled: boots, dormant (unit-tested for PRODUCTION).
- Key set: enrollment is always available to an unenrolled admin; there is no state in which an
  admin has a password but no path to enroll.
- Key later **lost** after someone enrolled: the API **refuses to boot** (outside LOCAL/DEV) rather
  than silently switching MFA off. Restore the key, or use break-glass with the key removed
  (break-glass only deletes rows and works without the key, but the boot check still needs the
  key restored or the rows removed first, so keep the key in the secret store with a backup).
- Lost phone: recovery code. Lost phone and codes: another super admin resets, or break-glass.

Recommended before arming production: create a **second** super admin and enroll both. A sole
administrator with a lost phone and lost codes is the one case that needs the break-glass deploy.

## 5. Threat model (short)

| Threat | Control |
| --- | --- |
| Stolen/phished password | Second factor required on every route; enrolled accounts get no tokens from the password alone. |
| Stolen password on a *not-yet-enrolled* admin | Attacker can sign in but only reach enrollment, which needs the password and ends all older sessions. This is the one window the migration creates: **enroll promptly after arming** (section 4). |
| Stolen access/refresh token (pre-MFA) | No `mfaCid` claim: refused on all staff routes; cannot enroll if the account already has an authenticator. |
| Replayed code | Step must be newer than `lastUsedStep`, conditional update. |
| Guessing | 5 failures, 15 minute lock, audit rows, per-IP throttle; codes are 6 digits over a +-1 window. |
| Token forgery of the claim | Claims are inside the signed JWT and re-checked against the database credential id per request. |
| Database leak | Secrets are AES-GCM ciphertext (key not in the DB); recovery codes are bcrypt; no plaintext anywhere. |
| Logs/audit leak | No code, recovery code, secret or nonce is logged or audited (asserted by a test that scans every audit row written during the run). |
| Insider with Railway access | Out of scope: they can already read the secret store and deploy. Break-glass is exactly that trust level. |

## 6. Break-glass

Same trust boundary as `FirstAdminBootstrap`: an operator-controlled environment variable read at
boot. **There is no HTTP route** (asserted by a test).

1. Set `MFA_BREAK_GLASS_EMAIL=<the one back-office account>` and
   `MFA_BREAK_GLASS_NONCE=<16+ random characters, new every time>`.
2. Redeploy. At boot, `MfaService.runBreakGlass()` removes that account's authenticator, recovery
   codes and sessions, writes `MFA_BREAK_GLASS` to the audit log (no actor: the deployment did it)
   and stores `sha256(nonce)` in `AdminMfaBreakGlassUse`.
3. The owner signs in with the **password** and is walked through enrollment again.
4. **Remove both variables.** Leaving them in place is harmless: the nonce is spent, later boots do
   nothing. A second use needs a new nonce.

It acts only on an existing account holding `ADMIN`/`SUPER_ADMIN`; an unknown address or a customer
is left alone and the nonce is **not** spent, so a typo can be fixed and redeployed. It does not
touch the password: an attacker who only has the switch still needs the password.

## 7. Environment variables and owner actions

| Variable | Where | Meaning |
| --- | --- | --- |
| `MFA_ENCRYPTION_KEY` | QA, UAT, PROD (secret) | 32 bytes base64. Encrypts secrets **and arms MFA**. Unset = dormant. Never rotate without re-enrolling (no key rotation tooling yet). |
| `MFA_ISSUER` | optional | Name in the authenticator app (default `ETicketsGo`; `APP_ENV` is appended outside PRODUCTION so QA and PROD entries differ). |
| `MFA_STEPUP_MINUTES` | optional | Step-up freshness, default 10. |
| `MFA_BREAK_GLASS_EMAIL`, `MFA_BREAK_GLASS_NONCE` | emergency only | Section 6. |

Owner actions, in order: (1) merge and deploy with the key unset (QA first, then UAT, then PROD, as
usual); (2) QA: set a QA key, run the certification below; (3) PROD: create the second super admin,
set the PROD key, sign in and enroll, store the recovery codes offline; (4) confirm the audit log
shows `MFA_ENROLLMENT_COMPLETED`.

## 8. Audit actions

`MFA_ENROLLMENT_STARTED`, `MFA_ENROLLMENT_REFUSED` (bad password), `MFA_ENROLLMENT_COMPLETED`,
`MFA_VERIFY_FAILED` (method + reason only), `MFA_LOCKED_OUT`, `MFA_RECOVERY_CODE_USED` (remaining
count), `MFA_RECOVERY_CODES_REGENERATED`, `MFA_DEVICE_REPLACED`, `MFA_RESET_BY_ADMIN`,
`MFA_BREAK_GLASS`.

## 9. Database

Migration `20261012120000_admin_mfa`, forward-only, **four new tables**, no existing column
changed, no row written: `AdminMfaCredential` (one per account), `AdminMfaRecoveryCode`,
`RefreshTokenMfa` (which sessions proved MFA), `AdminMfaBreakGlassUse`. `User` and `RefreshToken`
gain only Prisma back-relation fields (no DDL). Rolling the API back leaves the tables unused.

## 10. Tests

- `auth/mfa/totp.spec.ts`: RFC 6238 and RFC 4226 vectors, window, encryption round trip, AAD binding.
- `auth/mfa/mfa.boot.spec.ts`: first deploy boots dormant; lost key refuses to boot.
- `auth/mfa/admin-mfa.http.integration-postgres.spec.ts` (real Postgres, whole app over HTTP):
  existing-admin migration with no lockout; **route-table enumeration** (reflects on the running Nest
  app, sends three kinds of claimless admin session to every authenticated route, expects
  `403 MFA_REQUIRED` on all); replay, window, lockout, recovery, regeneration, refresh (no claim from
  nowhere, original `mfaAt` preserved), step-up, reset, break-glass, phone-code path, customers and
  organizers unaffected, no secrets in audit rows.

## 11. QA certification outline (for the lead, after merge and a QA deploy)

Prerequisite: a QA key set; the lead creates a QA test super admin `mfa-qa-1@...` and a second
`mfa-qa-2@...` (the agent does not create QA accounts).

1. With the key **unset**: both admins sign in and use the console as before; `/auth/me` shows
   `mfa.required: false`.
2. Set the key, redeploy. Sign in as `mfa-qa-1`: lands on `/enroll-mfa`; an admin API call with the
   pre-enrollment token returns 403 `MFA_REQUIRED`.
3. Enroll: take the secret from the page (or generate with any TOTP tool from the shown key), confirm,
   record the 10 recovery codes in the test notes (QA only).
4. Sign out, sign in: code step appears; wrong code x5 shows the lock message; wait or reset; a good
   code lets you in. A recovery code works once and not twice.
5. Replay: submit the same valid code twice in one 30 s step; the second is refused.
6. Step-up: on `/admin/staff`, wait 11 minutes, change a duty; the confirm dialog appears and the
   change then succeeds.
7. `mfa-qa-2` (verified) resets `mfa-qa-1`: `mfa-qa-1`'s open session is refused; it re-enrolls.
   `mfa-qa-2` trying to reset itself gets 403.
8. Customer and organizer logins unchanged (no code step).
9. Audit history shows the `MFA_*` rows above and none contains a code.
10. Break-glass on QA: set the two variables for `mfa-qa-1`, redeploy, confirm re-enrollment is
    required, remove the variables, redeploy, confirm nothing changes.
11. (QA only) Remove `MFA_ENCRYPTION_KEY` while an authenticator exists: the API must refuse to boot
    with a message naming the variable; restore it.

## 12. Residual risks

- **Enrollment window.** Between arming the key and the owner's first enrollment, anyone with the
  owner's password can enroll their own phone. Mitigation: arm the key and enroll immediately; the
  attacker also needs the password again at `enroll/start`.
- **Account lockout is also a denial of service.** Someone with only the password can keep an
  enrolled account locked 15 minutes at a time. Recovery: wait, another super admin, break-glass.
- **Single administrator.** Until a second super admin exists, the break-glass deploy is the only
  recovery from lost phone plus lost codes.
- **No key rotation tooling.** Changing the key invalidates every authenticator; they must be reset.
- **Challenge token is not single use** within its 5 minutes (the code it carries is). A stolen
  challenge alone gets nothing.
- **No email/notification** on recovery-code use or reset yet (audit rows only).
- **SHA-1 TOTP** is the interoperable default for authenticator apps (RFC 6238 uses it with HMAC, which is not affected by SHA-1 collisions).
- Mobile and customer-web are unchanged; an admin who tries to sign in there gets a clear refusal
  (they must use the admin console).
