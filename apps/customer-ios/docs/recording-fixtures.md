# Recorded API fixtures

`ETicketsGoTests/Fixtures/qa-*.json` are real responses from the QA API's **public, read-only**
endpoints. `RecordedContractTests` decodes them with the app's live decoder, so a model that
drifts from what the server sends fails in CI instead of on a phone.

**Re-recording rules**

- GET requests only. Never record anything that needs sign-in.
- Before committing, scan the files for emails, phone numbers and tokens.
- The record command is below.

```sh
B=https://api-qa.eticketsgo.com/api; D=apps/customer-ios/ETicketsGoTests/Fixtures
curl -s "$B/public/discovery"                 > $D/qa-discovery.json
curl -s "$B/public/events?page=1&pageSize=20" > $D/qa-events.json
curl -s "$B/public/movies"                    > $D/qa-movies.json
# take one event slug and one movie slug from discovery:
curl -s "$B/public/events/<event-slug>"       > $D/qa-event-detail.json
curl -s "$B/public/movies/<movie-slug>/shows" > $D/qa-movie-shows.json
grep -E -o '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|\+[0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}' $D/qa-*.json   # expect no output
```

**Signed-in endpoints** (`/bookings`, `/tickets`, `/auth/me`) are covered only by hand-written MOCK
fixtures (`Resources/MockData`). Recording them needs an approved QA test account. That's
blocked until the QA allowlist is approved and QA is stable.
