# QA demo dataset

Realistic demo events, films and licensed photography for the **QA environment only**, so image
cropping, focal points, portrait posters and very wide banners can be judged against something
that looks like a real catalogue rather than a wall of placeholders and timestamped test titles.

Everything is created through the public organizer and admin APIs, as `owner@eticketsgo.test`
(organization "Bengaluru Live") and `admin@eticketsgo.test`. No SQL, no seed service, no
Railway variables.

## What it creates

| What               | Count | Where                                                                                                  |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------ |
| Events (published) | 15    | 12 in India (Phoenix Arena Bengaluru, NSCI Dome Mumbai, ETG Vijayawada Multiplex), 3 in Boise (US)     |
| Event images       | 20    | landscape, portrait, square, wide (about 2:1) and very wide (3.3:1 and 4.3:1), each with a focal point |
| Films (published)  | 3     | fictional titles, abstract photographic posters                                                        |
| Film shows         | 9     | ETG Vijayawada Multiplex, Screen 1 (Andhra Pradesh), at the layout's own prices                        |
| Posters            | 3     | uploaded to each film's listing and served by the API (no third-party hotlinks)                        |

Categories: Music, Comedy, Conference, Workshop, Community, Food & Drink, Sports and films. Free
and paid events are mixed. One event, Film Appreciation Morning, has no image on purpose so the
branded placeholder stays visible. The list lives in `demo-dataset.mjs`; image provenance is in
`IMAGE-SOURCES.md` and `IMAGE-SOURCES.json`.

It does not create venues, cinemas, screens or layouts, buy tickets, or touch payment, pricing
policy, Telangana or USD rules. No Telangana venue is used.

## How demo items are identified

Titles are left clean (no "(QA demo)" suffix), because the point is to see how real-looking
titles sit in cards. Instead every item is marked in its text:

- The description (films: synopsis) **starts with** `QA demo content - not a real event.`
- It **ends with** `Demo key: qa-demo/<key>`, a stable key from `demo-dataset.mjs`.
- It credits the sample photos: `Sample photos (CC0, not the organizer's own): <author> via <source>.`

The API has no tag field, and the category is shown to buyers and drives the category filters,
so neither is used as the marker. The script treats an item as its own only when **both** the
marker and the key are present; anything else, including an item with the same title, is left
alone.

## Running it

From the repository root (Node 20+):

```sh
node scripts/qa-demo/seed-qa-demo.mjs --dry-run            # look up and print the plan, change nothing
node scripts/qa-demo/seed-qa-demo.mjs                      # create whatever is missing
node scripts/qa-demo/seed-qa-demo.mjs --only bom-night-10k # just these keys (comma-separated)
node scripts/qa-demo/seed-qa-demo.mjs --report run.json    # also write what it did, with ids
```

The script refuses any API other than QA (`api-qa.eticketsgo.com` or
`api-qa-f580.up.railway.app`) before it sends a single request; see `qa-guard.mjs`. Credentials
default to the seeded QA test accounts and can be overridden with `QA_DEMO_OWNER_EMAIL`,
`QA_DEMO_OWNER_PASSWORD`, `QA_DEMO_ADMIN_EMAIL` and `QA_DEMO_ADMIN_PASSWORD`.

It is idempotent. Each item is found again by its demo key, and only what is missing is added:
the event, its one session, its ticket types, the images not yet uploaded, review and approval;
for films, the film, its shows and its poster. Creates and uploads also send an
`Idempotency-Key`, so a request retried after a dropped connection does not make a copy. A
second run prints "nothing to do" for every item.

Each image is downloaded from the URL in `IMAGE-SOURCES.json` and refused if its sha256 no
longer matches, because the recorded licence describes those exact bytes.

## Removing it

```sh
node scripts/qa-demo/seed-qa-demo.mjs --cleanup --dry-run  # list what would change
node scripts/qa-demo/seed-qa-demo.mjs --cleanup
```

Cleanup archives each demo event (admin status `ARCHIVED`, which takes it off the storefront),
cancels each future demo film show (which frees the screen), archives each film's listing, and
archives each demo film. It acts only on items carrying the demo marker and key. Nothing is
deleted, so the records stay available for audit.

## Tests

```sh
node --test scripts/qa-demo/qa-guard.test.mjs scripts/qa-demo/venue-time.test.mjs
```
