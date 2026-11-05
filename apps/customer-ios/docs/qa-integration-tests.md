# QA integration tests

`ETicketsGoTests/QAIntegrationTests.swift` talks to the live QA API. It is **skipped by
default**: a plain `xcodebuild test`, and CI, never touch the network.

| Suite                        | Enabled by                                                               | What it does                                                                                                                                                                                                                                                                                                                         | Writes                                                       |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Public discovery (read-only) | `ETG_QA_LIVE=1`                                                          | Loads discovery, then an event's detail and a movie's shows. Pages through Explore. Checks that a write without an approved session is refused locally                                                                                                                                                                               | None                                                         |
| Signed-in                    | `ETG_QA_EMAIL` and `ETG_QA_PASSWORD` for an **approved QA test account** | Signs in and reads `/auth/me`, `/bookings`, `/bookings/:id`, `/tickets` and `/tickets/:id`. Checks that only server-issued codes render, that the offline copy has no token, that refresh rotates the pair, and that after logout the revoked refresh token is rejected. Also checks that a wrong password gets the server's message | Session only: login, refresh and logout for that one account |

## Run

```sh
cd apps/customer-ios
# read-only
TEST_RUNNER_ETG_QA_LIVE=1 xcodebuild test -project ETicketsGo.xcodeproj -scheme ETicketsGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:ETicketsGoTests
# signed in (approved account only; type the values at run time, never commit them)
TEST_RUNNER_ETG_QA_LIVE=1 TEST_RUNNER_ETG_QA_EMAIL=… TEST_RUNNER_ETG_QA_PASSWORD=… xcodebuild test …
```

`xcodebuild` passes `TEST_RUNNER_<NAME>` to the test process as `<NAME>`.

**Credentials**

- The test builds its allowlist from the one account supplied. It does not read `QA.local.xcconfig`.
- Nothing is persisted: it uses an in-memory token store.

**Account requirements:** use a dedicated QA account that has at least one confirmed booking.
Logout revokes that account's session on QA.

**Never run this against PROD.** The configuration is hard-wired to `api-qa.eticketsgo.com`.
