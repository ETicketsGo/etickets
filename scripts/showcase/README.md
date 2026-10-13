# Showcase catalogue (local machine, and QA by name)

Sixteen fictional listings - 12 events and 4 films in Bengaluru, Mumbai, Hyderabad, New Delhi,
New York and Toronto - so designers can take honest screenshots on their own machine instead of
judging layouts against rows called "Test Event 1712...". The content lives in
`catalogue.mjs`; `load-showcase.mjs` puts it on a local stack through the public organizer and
admin APIs, the same way an organizer and an admin would.

**Never run this against UAT or production.** The only remote target is QA, by `--target qa`
(see "On QA" below). `local-guard.mjs` refuses, before the first
request, any API whose host is not exactly `localhost`, `127.0.0.1` or `::1` over plain http
(any port). https, QA and Railway hosts, LAN addresses and typos are all refused.

## What it creates

| What            | Count | Notes                                                                                     |
| --------------- | ----- | ----------------------------------------------------------------------------------------- |
| Organizers      | 10    | one account `showcase+<key>@eticketsgo.test` and one organization each, approved as admin |
| Venues          | 16    | found by name, created if missing, with city, state, country and time zone                |
| Cinemas         | 4     | each with `Screen 1` and a simple seat layout priced as its film's ticket classes         |
| Events          | 12    | one session, the catalogue's ticket types, a cover photo with focal point, approved       |
| Films and shows | 4, 30 | published; shows on the cinema's screen at the catalogue's times and prices               |

Organizer passwords are derived from the organizer key (optionally salted with
`SHOWCASE_PASSWORD_SALT`) so a re-run can sign in again; nobody needs to know them. If organizer
sign-up or approval is refused (for example the admin login asks for an authenticator code),
everything falls back to the seeded `owner@eticketsgo.test` organization and the run says so;
`--single-org` forces that.

Prices are in the venue's own currency (INR, USD, CAD). The loader never changes pricing
policy, tax, payment or market settings. If the platform refuses a listing, the reason is
printed and written to the report. No cinema is in Telangana.

## How showcase items are identified

Every description (films: synopsis) ends with:

```
<about text>

Showcase listing: fictional, for design review on a local machine.
Showcase key: showcase/<key>
```

An item is treated as the loader's own only when the marker is present and the key line ends
the text. Anything else, including an item with the same title, is left alone.

## Running it

Build and start a local API on port 4131 (from the repo root, then `apps/api`). The higher
`ORG_REGISTRATION_THROTTLE_LIMIT` lets one machine register ten organizations in an hour:

```sh
npx turbo run build --filter=@eticketsgo/api
cd apps/api && PORT=4131 APP_ENV=LOCAL CORS_ORIGINS=http://localhost:3131 THROTTLE_LIMIT=2000 \
  AUTH_THROTTLE_LIMIT=1000 ORG_REGISTRATION_THROTTLE_LIMIT=100 node dist/main.js
```

Then, from the repo root (Node 20+):

```sh
node scripts/showcase/load-showcase.mjs --dry-run              # print the plan, change nothing
node scripts/showcase/load-showcase.mjs                        # create whatever is missing
node scripts/showcase/load-showcase.mjs --only blr-neon-raga   # just these keys (comma-separated)
node scripts/showcase/load-showcase.mjs --report run.json      # also write what it did, with ids
```

Other options: `--api <base>` (default `http://localhost:4131/api`), `--images <dir>`,
`--credits <file>`, `--catalogue <file>` (another module with the same exports, for stress content
such as long titles and listings with no picture; marked and removed like the showcase's own).

Film posters: the movie schema requires `posterUrl` to be an absolute URL, so the loader saves
the API address it ran against. The storefront re-bases any URL on the platform's own image
route onto the API it is talking to (`portableImageUrl` in web-kit), so posters show whatever
port or host the API is on now. Re-running the loader against a new `--api` also re-stamps them. It is idempotent: a second run prints "nothing to do" for every item.

To see it: `cd apps/customer-web && NEXT_PUBLIC_API_URL=http://localhost:4131/api npx next dev -p 3131`.
The storefront scopes listings by location, so use an India time zone or pick a city.

## Images and credits

Photos are NOT in the repository. They live in `C:\etg-wt\showcase\images\<key>.jpg`, with
photographers and licences in `C:\etg-wt\showcase\CREDITS.md` and `credits.json` (which also
carries each photo's focal point). A missing image is skipped with a warning; run again once it
is there. A file over the API's 2 MB limit is shrunk with the `sharp` the API already uses.

## Removing it

```sh
node scripts/showcase/load-showcase.mjs --remove --dry-run   # list what would change
node scripts/showcase/load-showcase.mjs --remove
```

Events are deleted (with their sessions, tickets and images) when nothing was sold, otherwise
archived. Films: future shows are cancelled, each listing is deleted (or archived), and the
film is archived. Organizer accounts, organizations, venues, cinemas and screens are left in
place: the API has no way to delete a venue, and keeping them makes the next load quicker.

## Tests

```sh
node --test scripts/showcase/*.test.mjs
```

## On QA

QA keeps its certification fixtures ("Test Event 1712...", "K-TEST ...") and nothing is deleted.
The API labels every public listing outside production: DEMO when its organization is listed
in the `DEMO_ORGANIZATION_IDS` variable, TEST otherwise, and the storefront shows a quiet
"Sample event" or "Test event" badge and puts DEMO first. In production the label is always null.

```sh
node scripts/showcase/load-showcase.mjs --target qa --dry-run   # reads only
node scripts/showcase/load-showcase.mjs --target qa             # creates what is missing
node scripts/showcase/load-showcase.mjs --target qa --remove    # takes the showcase down again
```

- `--target qa` allows exactly `https://api-qa-f580.up.railway.app/api`. UAT, production,
  custom domains, other Railway hosts and any other port or scheme are refused before a request.
  If Railway changes the generated host, change `QA_API` in `local-guard.mjs` in a reviewed commit.
- It signs in as the QA admin (`SHOWCASE_ADMIN_EMAIL` / `SHOWCASE_ADMIN_PASSWORD`; the seeded
  test admin if unset). When the admin has MFA armed, the loader computes the TOTP code
  (RFC 6238, SHA-1, 6 digits) from the base32 secret in `--admin-totp-file` (default
  `C:/etg-wt/qa-secrets/qa-mfa.json`, a JSON object keyed by email; never printed), completes
  `/auth/mfa/verify`, and answers a `MFA_STEP_UP_REQUIRED` with `/auth/mfa/step-up` once. A code
  is never used twice in one 30 s step, so a second sign-in waits for the next step. No secret
  for the account means a refusal.
- Organizer passwords are random and written to `C:/etg-wt/qa-secrets/showcase-qa-accounts.json`
  (`--accounts-file` to change), before the account is registered. They are never printed.
  Keep that file: a re-run needs it. There is no fallback to the seeded owner's organization.
- Every listing says "Showcase listing: fictional, for demonstration on the QA environment."
- Re-running is safe: items are found again by their key line. `--remove` touches only items
  that carry the showcase marker and key.
- It prints `DEMO_ORGANIZATION_IDS=<id>,<id>,...` at the end. Set that variable on the QA API
  service (and nowhere else), then redeploy it, so the listings are labelled DEMO.
