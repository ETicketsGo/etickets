# Showcase catalogue (local machine only)

Sixteen fictional listings - 12 events and 4 films in Bengaluru, Mumbai, Hyderabad, New Delhi,
New York and Toronto - so designers can take honest screenshots on their own machine instead of
judging layouts against rows called "Test Event 1712...". The content lives in
`catalogue.mjs`; `load-showcase.mjs` puts it on a local stack through the public organizer and
admin APIs, the same way an organizer and an admin would.

**Never run this against QA, UAT or production.** `local-guard.mjs` refuses, before the first
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
`--credits <file>`. It is idempotent: a second run prints "nothing to do" for every item.

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
