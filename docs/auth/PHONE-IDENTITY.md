# Phone identity and account country

Status: implemented on branch `feat/phone-identity-and-country`, not merged, not deployed.
Owner report (2026-10-25): "I can repeatedly sign up using the same mobile number without
receiving an 'account already exists' message." And: the production admin Accounts page showed
8 accounts, 7 of them "Country not known".

## 1. Root cause

### 1.1 Repeat sign-up with the same number

The server was already safe. The clients were not.

- `User.phone` has had a unique index (`User_phone_key`) since the first migration, and the API
  only ever writes `phone` together with `phoneVerifiedAt`, after a code has been proved.
- Numbers are normalised to E.164 before they are stored or compared
  (`apps/api/src/auth/phone.ts`, `normalisePhone`). `+91 98765 43210`, `+91 098765 43210`,
  `0091 9876543210` and `+919876543210` are one value. A bare national number is refused by the
  API; the clients add the chosen country (`toE164`).
- `POST /auth/phone/verify` with a number that already has an account signs the person into
  THAT account and answers `isNewAccount: false`. No second user row is created. Two
  simultaneous verifications of a new number create one user (the unique index plus a P2002
  re-read of the winner).

What was wrong:

1. **Neither client read `isNewAccount`.** The website's Mobile sign-up tab and the Android app
   went on exactly as for a brand-new account. So a second "Create account" with the same
   number looked like success every time, and nobody was ever told "you already have an
   account". This is the reported behaviour.
2. **The API applied sign-up data to an existing account.** `applyPhoneSignup` ran for every
   verify. On an existing account it (a) filled the name if the account had none (a phone-only
   account made by the Sign-in tab), and (b) recorded a `CUSTOMER_SIGNUP` text-message consent
   row, which is evidence of a sign-up that never happened.
3. **The Android app had no phone sign-up at all**: "Create account" was email only, and the
   Mobile tab on the sign-in screen created accounts silently.

Nothing was found that creates a duplicate user for one verified number, shares a session
across accounts, or lets an unverified number grant access.

### 1.2 "Country not known"

`User` had no country of any kind. The admin Accounts "Country" column was derived only from
activity: venue countries of the account's bookings, and registered countries of the
organizations it belongs to. A customer who had signed up but not bought anything (7 of 8 in
production) had no country, although the platform did know other things - the verified
phone's calling code, and where the network placed the sign-up.

## 2. Design

### 2.1 Phone identity

| Rule                                                  | Where                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| One stored spelling (E.164)                           | `normalisePhone` (unchanged)                                |
| One verified number, one account                      | `User_phone_key` unique index (unchanged, since init)       |
| Concurrent first verifies make one user               | P2002 on create, re-read the winner (unchanged, now tested) |
| Request-code says nothing about accounts              | `requestCode` answers the same either way (unchanged)       |
| Sign-up data only for an account this request created | `AuthController.verifyPhoneCode` (NEW)                      |
| Client says "already have an account" on sign-up      | `phoneSignInOutcome` in shared-types, both clients (NEW)    |
| A number on account A cannot attach to account B      | `attachToAccount` 409 (unchanged, now tested)               |
| Account deletion frees the number                     | `AccountDeletionService` (unchanged, now tested)            |

The sign-up form cannot know before the code is proved whether the number has an account;
saying so at request-code time would let anybody test who is registered. So the answer comes
with the proved code:

- Sign-up tab, new number: account created, name applied, US text-message agreement recorded.
- Sign-up tab, existing number: signed into the existing account. Nothing from the form is
  applied. The screen says "You already have an account with this number. We signed you in."
  and waits for **Continue**.
- Sign-in tab: unchanged.

Email sign-up keeps its existing duplicate handling (409 "already registered").

No automatic merging. An email account and a phone account belonging to the same person stay
two accounts; the audit (section 4, query 7) lists likely pairs for a human to look at.

### 2.2 Country evidence (minimum new fields)

Four facts, each labelled by where it came from, never combined:

| Fact                 | Stored as                                                             | Set by                                                                                                             |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phone calling code   | not stored - read from verified `User.phone` (`phoneCallingCode`)     | the verified number; `+1` is shown as `+1 (US/CA)`                                                                 |
| Country of residence | `User.countryOfResidence` (NEW, nullable, ISO alpha-2 market code)    | ONLY the person, on their profile (`PATCH /users/me { countryOfResidence }`, `null` clears)                        |
| Detected country     | `User.detectedCountry` + `User.detectedCountrySource` (NEW, nullable) | account CREATION only (email register or new phone account), from the storefront's trusted edge headers, `network` |
| Activity countries   | not stored - derived as before (bookings, organizer memberships)      | unchanged                                                                                                          |

Residence is never set from the phone prefix, the network or bookings. Neither web nor Android
asked for a country at sign-up before this change, so none is asked now: residence is an
optional profile field (website profile page). The Android app has no residence picker yet.

The calling code is derived at read time rather than stored: `User.phone` is already
verified-only and E.164, so a derived value cannot drift from the number, needs no backfill, and
works for rows written by the old API during the rollout window.

Detected country comes from `cf-ipcountry` / `x-vercel-ip-country` / `x-appengine-country`
(`apps/api/src/discovery/network-country.ts`, the same list `LocationService.resolve` uses).
`XX` and `T1` mean "could not tell" and are not stored. It is only as trustworthy as the proxy
in front of the API: if the API is reachable without Cloudflare, a caller can send the header
themselves, so it is always labelled as a network hint, never as a residence.

Admin Accounts page (`apps/admin-web/app/admin/users/page.tsx`):

- column **Country evidence**: `Lives in: CA`, `Phone: +1 (US/CA)`, `Detected: IN (network)`,
  `Active in: India`, or `No country evidence`;
- cards: Accounts / Countries active in / **No activity country yet** (was "Country not
  known") / **No country evidence at all** (new);
- card **Other country evidence**: verified phones by calling code, residence, detected.
- The country filter still filters by activity, as before.

Admin API (`GET /users`, `GET /users/directory-summary`) is additive: `countries` and
`withoutCountry` keep their meaning and names; new fields are `activityCountries`,
`countryOfResidence`, `detectedCountry`, `detectedCountrySource`, `phoneCallingCode`,
`phoneCallingCodeLabel`, and in the summary `withoutActivityCountry`,
`withoutAnyCountryEvidence`, `byResidence`, `byDetected`, `byPhoneCallingCode`. An older admin
console ignores them; a newer console against an older API shows activity only.

## 3. Migration plan

Migration `20261025180000_user_country_evidence`:

```sql
ALTER TABLE "User" ADD COLUMN "countryOfResidence" TEXT;
ALTER TABLE "User" ADD COLUMN "detectedCountry" TEXT;
ALTER TABLE "User" ADD COLUMN "detectedCountrySource" TEXT;
```

- Additive only: three nullable columns, no default, no constraint, no index, no backfill, no
  data change. Adding a nullable column with no default is a catalogue-only change in Postgres
  16 (no table rewrite, brief lock).
- Backward compatible: the currently deployed API inserts and updates users without naming these
  columns and keeps working. Nothing reads them until the new API is deployed.
- No uniqueness migration: verified-phone uniqueness is already enforced by `User_phone_key`.
  The one thing an index on stored strings cannot catch is two spellings of one number. The
  audit below finds those. **If the audit ever finds duplicates, do not add or change any
  constraint and do not delete or merge rows automatically** - see 4.2.
- Backfill: none. Residence stays unknown until a person chooses it. A detected country cannot
  be recovered for an existing account (it is a fact about the sign-up request). The calling code
  is read from the verified phone, so existing verified numbers show it immediately.
- Rollback: the old API ignores the columns, so rolling the API back needs no schema change.
  Dropping the columns is not required and is not recommended (it would be destructive).

Rollout order: deploy the API (it runs `prisma migrate deploy` at start) **first**, then
customer-web and admin-web, then ship the Android build. A web or app client older than the API
keeps working (it ignores `isNewAccount`, as today). A newer client against an older API is
safe: a missing `isNewAccount` on the sign-up tab is read as "existing" (the harmless
direction), and the admin console falls back to activity-only.

## 4. Production read-only audit

Script: `apps/api/scripts/audit-phone-identity.sql`.

- Runs inside `BEGIN TRANSACTION READ ONLY` and ends in `ROLLBACK`; every statement is a
  `SELECT` (CI test `audit-phone-identity.integration-postgres.spec.ts` enforces this and proves
  a write is refused inside it).
- Uses only columns that exist before the migration, so run it BEFORE deploying.
- Prints masked numbers (`+91 ...3210`) and user ids, never a full number or an email.

```sh
# A read-only role if one exists. Never with a write-capable URL pasted into a shared shell.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/audit-phone-identity.sql
```

### 4.1 Sections

| #   | Finding                                                        | Meaning                                                     |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 0   | overview                                                       | counts; `phone_unique_index_present` must be 1              |
| 1   | duplicate numbers after normalisation                          | one number on several accounts (two spellings)              |
| 2   | stored numbers not in canonical E.164                          | a row written outside `normalisePhone`                      |
| 3   | calling code not a platform market                             | cannot be texted; informational                             |
| 4a  | phone present, never verified                                  | must not be trusted for sign-in                             |
| 4b  | verified timestamp, no phone                                   | harmless leftover                                           |
| 5   | phone-only placeholder email that no longer matches its number | a new sign-up with that number is refused (409) until fixed |
| 6   | deleted account still holding a number                         | blocks the number forever                                   |
| 7   | number declared on one account, verified on another            | probably one person, two accounts; informational            |
| 8   | sign-in code rows with a non-canonical number                  | count only                                                  |

Expected on a healthy database: sections 1, 2, 4a, 5 and 6 empty.

### 4.2 Remediation path (human, one row at a time, never automatic)

- **1 / 2 (two spellings of one number):** decide with the owner which account is the person's
  real one (bookings, last sign-in, support contact). The other row's number is cleared
  (`phone = NULL, "phoneVerifiedAt" = NULL`) in a reviewed, single-row change, after which the
  person signs in with the number and lands on the kept account. Bookings are never moved
  between accounts by this process. Record the decision in the audit log / ticket.
- **4a:** clear `phone` on that row, or have the holder re-verify by attaching the number from
  the profile (which proves it).
- **5:** the row is a phone-only account whose number was removed by hand. If it is abandoned,
  delete it through the account-deletion flow (which replaces the placeholder email). If not,
  restore its number.
- **6:** clear `phone` and `phoneVerifiedAt` on the deleted row.
- **7:** contact the person if needed. Do not merge.

Every write above is outside this change and needs the owner's explicit approval.

## 5. QA certification (after merge and QA deploy; the main session runs this)

Pre-checks:

1. `node scripts/verify-deployed.mjs` (or the release checklist) shows QA api, customer-web and
   admin-web on the merge commit.
2. QA texts nobody (provider `log`), so phone codes are not deliverable on QA unless SMS is
   configured there. If the Mobile tab says "Sign-in by text message is not available yet", the
   phone journeys below are **BLOCKED**, not passed - do not bypass the OTP or the human check.
   Use the API Postgres suite evidence instead and record the block.
3. Use test numbers you own, and tag every test account's name with `QA-PHONE-<date>` so cleanup
   finds only those.

### 5.1 Website (desktop and phone width)

| #   | Step                                                                              | Expected                                                                          |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| W1  | /register, Mobile tab, new number, name `QA-PHONE-<date> One`, code               | signed in, lands on the next page, no "already" message                           |
| W2  | sign out; /register, Mobile tab, SAME number, name `Other Name`, code             | "You already have an account with this number. We signed you in." and Continue    |
| W3  | after W2, open Account > Profile                                                  | name is still `QA-PHONE-<date> One`; Bookings shows the same bookings as after W1 |
| W4  | /register Mobile tab with the number typed `+91 0XXXXX XXXXX` or pasted `0091...` | same account as W1 (W2 message)                                                   |
| W5  | /login Mobile tab with the same number                                            | signs in, no message                                                              |
| W6  | request a code twice within 60 s                                                  | second request refused "Wait N seconds" (limits unchanged)                        |
| W7  | wrong code                                                                        | "That code is not valid. Ask for a new one." No account created                   |
| W8  | email account: Profile > Add a mobile number with the W1 number                   | refused: "That number is already on another account"                              |
| W9  | Profile > Country you live in: choose Canada, Save; reload                        | Canada kept; choose "I would rather not say", Save; reload, cleared               |
| W10 | /register Email tab with an existing email                                        | unchanged "already registered" behaviour                                          |

### 5.2 Android (Moto G31, QA build)

| #   | Step                                                             | Expected                                                                   |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1  | Create account > Mobile tab (Full name shown), new number, code  | signed in, sheet closes                                                    |
| A2  | sign out; Create account > Mobile tab, same number, another name | "You already have an account with this number. We signed you in." Continue |
| A3  | Account screen                                                   | original name; same tickets as after A1                                    |
| A4  | force-stop the app, reopen (aeroplane mode once, then online)    | still signed in; offline wallet still shows tickets                        |
| A5  | Sign in > Mobile tab, same number                                | signs in, no message                                                       |
| A6  | Create account > Email tab                                       | unchanged email sign-up                                                    |

### 5.3 Admin console (QA)

| #   | Step                    | Expected                                                                                     |
| --- | ----------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Accounts page           | cards: Accounts / Countries active in / No activity country yet / No country evidence at all |
| D2  | the W1 account row      | `Phone: +91 (IN)`; `Detected: <CC> (network)` if QA is behind Cloudflare; no "Lives in"      |
| D3  | after W9 (Canada)       | `Lives in: CA` on that row and Canada under "Lives in" in Other country evidence             |
| D4  | an account with nothing | `No country evidence`                                                                        |

### 5.4 QA rows (read-only SQL)

Run inside a read-only transaction on QA:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT u."id", u."fullName", '...' || right(u."phone", 4) AS phone_last4,
       u."phoneVerifiedAt" IS NOT NULL AS verified, u."countryOfResidence",
       u."detectedCountry", u."detectedCountrySource", u."createdAt", u."status",
       (SELECT count(*) FROM "Booking" b WHERE b."userId" = u."id") AS bookings,
       (SELECT count(*) FROM "RefreshToken" r WHERE r."userId" = u."id") AS sessions,
       (SELECT count(*) FROM "MarketingConsent" m WHERE m."userId" = u."id") AS consents
FROM "User" u
WHERE u."fullName" LIKE 'QA-PHONE-%' OR u."phone" IN ('+91XXXXXXXXXX' /* the test numbers */)
ORDER BY u."createdAt";
ROLLBACK;
```

Pass: exactly ONE row per test number; after W2/A2 the row's `fullName` is unchanged, `consents`
did not increase, and `bookings` is unchanged. Also run `audit-phone-identity.sql` on QA:
sections 1, 2, 4a, 5, 6 empty.

### 5.5 Cleaning up test accounts only

Use the product, not SQL: sign in as each `QA-PHONE-*` account and use **Account > Delete
account** (web or app). That clears the number and anonymises the row through the same code path
customers use, and it touches nothing else. Confirm with the 5.4 query that only the test rows
changed (status `DELETED`, phone NULL). Never delete by pattern in SQL, and never touch an
account that is not tagged `QA-PHONE-`.

## 6. Tests (where each requirement is proved)

API, real Postgres (`*.integration-postgres.spec.ts`, run in CI with the service database):

- `apps/api/src/auth/phone-identity.integration-postgres.spec.ts` - cases 1, 2, 2b, 2c, 3, 4, 5,
  6, 7, 7b, 8, 12, 13/14 (user ids, row counts, names, consents, sessions, bookings).
- `apps/api/src/users/account-country.integration-postgres.spec.ts` - cases 10, 10b, 11, and
  the +1 / network / residence separation through the profile and admin APIs.
- `apps/api/src/auth/audit-phone-identity.integration-postgres.spec.ts` - the audit is
  read-only and finds what it reports.

Unit: `packages/shared-types/src/phone-identity.spec.ts`, `apps/api/src/discovery/network-country.spec.ts`,
`apps/api/src/users/user-directory.spec.ts`, `apps/customer-web/components/phone-sign-in.test.ts`,
`apps/customer-web/lib/phone-number.test.ts` (case 4 client side),
`apps/customer-mobile/src/features/auth/__tests__/phone-sign-up.test.tsx` (renders the real
component), `apps/customer-mobile/src/application/__tests__/auth-store.test.ts` (case 9, session
survives a restart), `apps/customer-mobile/src/features/auth/__tests__/phone-number.test.ts`.

## 7. Open questions for the owner

1. Strict rule chosen: a sign-up over an existing phone-only account with NO name does not fill
   the name (before, it did). The person can set it in the profile or at checkout. Keep strict?
2. Should the Android app get the same optional "Country you live in" picker as the website?
3. Should the detected country be captured only when the API is confirmed behind Cloudflare
   (otherwise a client can send the header)? Today it is stored and labelled as a hint.
4. Audit section 7 pairs (email account + phone account, one person): a support-led "move my
   number" flow is the safe answer; it is not built.
