# ETicketsGo — native iOS customer app (Phase 1 foundation)

Native SwiftUI app (no WebView), iOS 17+, Swift 6 language mode with strict concurrency, no
third-party packages. It sits beside the Expo app in `apps/customer-mobile`, which is unchanged.

## Run it

```sh
open apps/customer-ios/ETicketsGo.xcodeproj      # scheme "ETicketsGo" (MOCK) → Run
# or from the command line:
xcodebuild -project apps/customer-ios/ETicketsGo.xcodeproj -scheme ETicketsGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

There's no `package.json` here, so npm and Turbo don't treat this folder as a workspace.

## Environments

| Build configuration | Scheme                | Data                                                    | Writes                          | Bundle id                                   |
| ------------------- | --------------------- | ------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| **Mock** (default)  | `ETicketsGo` Run/Test | Bundled JSON in `Resources/MockData`, no network at all | Blocked                         | `com.eticketsgo.customer.native.mock`       |
| **QA**              | `ETicketsGo QA`       | `https://api-qa.eticketsgo.com/api`                     | Allowed (none exist in Phase 1) | `…native.qa`                                |
| **Prod**            | `ETicketsGo` Archive  | `https://api.eticketsgo.com/api`                        | **Always blocked in Phase 1**   | `…native` (placeholder, see open decisions) |

The values live in `Config/*.xcconfig`, pass through `Config/Info.plist`, and are read by
`AppConfiguration`. If a value is missing or isn't an `https` URL, the app falls back to MOCK.

`AppConfiguration.permits(_:)` refuses every non-GET request in PROD, whatever the xcconfig says.
`APIClient` checks this before it builds a request, and a unit test proves nothing gets sent.

The config files contain no secrets: the API hosts are public, and no keys or tokens are stored.

## Structure

```
apps/customer-ios/
├── ETicketsGo.xcodeproj        hand-written; folder-synchronised groups (Xcode 16+), so new
│                               files under ETicketsGo/ and ETicketsGoTests/ need no project edits
├── Config/                     Base / Mock / QA / Prod .xcconfig + Info.plist keys
├── ETicketsGo/
│   ├── App/                    @main, AppContainer (composition root), tabs + Route navigation
│   ├── Core/
│   │   ├── Config/             AppConfiguration, environment + write policy
│   │   ├── Networking/         APIClient (transport, errors, bearer, correlation id), CustomerAPI endpoints
│   │   ├── Models/             wire models (= API contract) and display formatting
│   │   └── Data/               repository protocols; Remote* (QA/PROD) and Mock* implementations
│   ├── DesignSystem/           tokens (colour, type, spacing, radius), buttons, chips, cards, states
│   ├── Features/               Home, Explore, Movies (+ movie detail/showtimes), EventDetail,
│   │                           Tickets (list + ticket code), Profile — each view + @Observable view model
│   └── Resources/              Assets (app icon, accent), MockData/*.json
├── ETicketsGoTests/            Swift Testing: configuration, APIClient, models/fixtures, view models
└── docs/screenshots/           simulator captures
```

**Architecture**

- **Feature MVVM.** Views own a `@MainActor @Observable` view model. Every view model exposes its data as `Loadable<Value>` (idle / loading / loaded / failed), and `LoadableView` renders those states the same way on every screen.
- **Repositories.** View models depend only on the `CatalogRepository`, `TicketsRepository` and `AccountRepository` protocols. `AppContainer` picks Mock or Remote implementations once, from the build's environment. Replacing mocks with NestJS means changing nothing above the repository layer.
- **Wire models are the contract.**
  - Field names and optionality match the API, cross-checked against the zod schemas the Expo app validates with.
  - Mock fixtures are written in the same wire format and decoded with the same decoder (`JSONDecoder.etg`). A fixture that drifts from the contract fails the same way a live response would.
- **Server-authoritative.** The app shows prices, availability and ticket validity; it never computes them.
  - Prices shown are from the API. Booking is disabled in Phase 1.
  - Ticket codes come only from the server-rendered `qrDataUrl`. The app never builds a QR from `qrToken`, because `tickets.service.ts` decides what is presentable (our token, a vendor barcode, or nothing).
- **Design system.** Colours mirror the storefront's "Luxury Editorial" palette in `packages/design-tokens/src/brand.css`: ivory, ink and gold, with the stage tone for dark mode. Corner radii are 10 for controls and 16 for cards. Type uses Dynamic Type text styles. The app icon is the storefront's "E." mark.
- **Accessibility.**
  - Dynamic Type on all text.
  - Cards and rows are combined into single VoiceOver elements, with hints on them.
  - Headers are marked as headers, and decorative art is hidden from VoiceOver.
  - Selected chips carry the selected trait.
  - Tap targets are at least 36pt; buttons are 50pt.
  - Light and dark mode are both supported.
- **Debug-only launch arguments.** `-ETGTab movies` and `-ETGEvent <slug>` open a screen at launch. They're used for screenshots and compiled out of PROD.

## What is real vs mocked (Phase 1)

| Area                                                                                                                   | Status                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six screens, navigation, design system, states, previews                                                               | **Implemented**, running on the simulator against MOCK                                                                                                                                                                                             |
| Networking layer: URL building, `/api` prefix, bearer header, `x-correlation-id`, error-body mapping, PROD write guard | **Implemented and unit-tested** with a stub transport                                                                                                                                                                                              |
| Remote repositories for discovery, events, event detail, movie shows, tickets, `/auth/me`                              | **Implemented, not yet run against a live server**. The QA build compiles, but no QA request has been run from this app                                                                                                                            |
| Data shown in MOCK                                                                                                     | **Mocked**: fictional events, venues, people and tickets. Ticket QR images encode `MOCK.<serial>`, which is not a valid ticket                                                                                                                     |
| Search and category filtering in MOCK                                                                                  | **Mocked** locally. Real filtering is the server's                                                                                                                                                                                                 |
| Sign-in, token storage, refresh, sign-out (Phase 2A)                                                                   | **Implemented and unit-tested.** The MOCK adapter runs on the simulator. The QA adapter is tested against a stub transport but **not yet against QA**, because the QA test-account allowlist is empty until it's approved. PROD sign-in is blocked |
| Booking, holds, checkout, payment                                                                                      | **Not implemented** (out of scope). The button is disabled                                                                                                                                                                                         |

## API contract inventory (verified in apps/api)

All endpoints sit under the global prefix `/api` (`apps/api/src/main.ts`). There is no URI or header versioning and no success envelope.

- **Errors** come back as `{ code, message, details, correlationId }` from `common/all-exceptions.filter.ts`.
- **Lists** are paginated as `{ data, meta: { page, pageSize, total, totalPages } }`, with `page` and `pageSize` (1–100) as query parameters.
- **Money** is integer `*Minor` amounts plus a `currency` code. **Dates** are ISO-8601.

| Used by this app  | Method / path                                                                                   | Auth   | Source                                 |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------ | -------------------------------------- |
| Home, Movies list | GET `/public/discovery` (`city`, `country`)                                                     | public | `discovery/discovery.controller.ts:18` |
| Explore           | GET `/public/events` (`q`, `category`, `city`, `page`, `pageSize`, dates…)                      | public | `events/events.controller.ts:441`      |
| Event detail      | GET `/public/events/:slug`                                                                      | public | `events.controller.ts:502`             |
| Event images      | GET `/public/events/:id/images/:imageId/:variant` (paths come in `imagePath` / `imageVariants`) | public | `events.controller.ts:520-555`         |
| Movie showtimes   | GET `/public/movies/:slug/shows` (`city`, `country`, `from`, `to`, `limit`)                     | public | `movies/movies.controller.ts:188`      |
| My Tickets        | GET `/tickets`                                                                                  | bearer | `tickets/tickets.controller.ts:12`     |
| Profile           | GET `/auth/me`                                                                                  | bearer | `auth/auth.controller.ts:215`          |

Other endpoints Phase 2 needs:

- **Auth**
  - POST `/auth/login`, `/auth/register`, `/auth/refresh` and `/auth/logout`. These return `{accessToken, refreshToken}`; the access token lives 15 min and the refresh token 30 days, and refresh tokens rotate.
  - Phone OTP: `/auth/phone/request-code` and `/auth/phone/verify`.
- **Catalog**
  - GET `/public/shows/:sessionId/seats`.
  - GET `/public/categories`.
  - GET `/public/location/resolve`.
  - GET `/public/movies/:slug`.
- **Bookings and tickets**
  - GET `/bookings` and `/bookings/:id`.
  - GET `/tickets/:id`.
- **Booking and payment**
  - POST `/bookings/quote`.
  - POST `/bookings`, with an `idempotency-key` header.
  - POST `/bookings/:id/pay`, `/extend-hold` and `/cancel`.
  - The guest booking routes.
- **Profile and notifications**
  - GET and PATCH `/users/me`.
  - DELETE `/users/me`.
  - `/me/notification-preferences`.
  - POST `/users/me/devices`, which accepts `provider: apns`.

## Outstanding integration dependencies

1. **Venue time zone. Corrected after investigation.** The API does send zones: `venue.timezone` on event cards, `timeZone` on event detail and on each session, `timezone` on tickets, and `cinema.timezone` on movie shows. The app now shows every time in the venue's zone and names the zone when it differs from the device's. One gap is left: shows with no cinema carry no zone (see `docs/api-contract-proposals.md`).
2. **`qrToken` can be null.** `tickets.service.ts` withholds it from viewers who may not present a ticket, such as a buyer who transferred it away. The native model treats it as optional. The Expo app's schema does not, so one such ticket empties its whole wallet (see `docs/api-contract-proposals.md`).
3. **GET `/public/movies`.** It is now confirmed: a plain array of at most 60 items, the same shape as discovery's `nowShowing`, plus `rating` and `contentLabel`. Moving the Movies tab onto it, so it can filter by city, genre and search, is Phase 2.
4. **QA availability.** The Railway QA environment is reported to be unreliable. The QA scheme hasn't been exercised end to end from this app.
5. **Open decisions.**
   - The production bundle id: take over `com.eticketsgo.customer` from the Expo app, or ship a new one.
   - The Apple Developer team and signing.
   - Whether to bundle Inter to match the web's typeface, or stay on SF Pro.
6. **`apps/customer-mobile/docs/API-INTEGRATION.md` is out of date.** It lists forgot-password, account deletion and guest claim as gaps, but all three exist.

## Phase 2A: authentication

**Contract** (audited in `apps/api/src/auth/auth.controller.ts` and `packages/validation/src/auth.ts`)

- **Email sign-in and sign-up.** `POST /auth/login` takes `{email, password}`. `POST /auth/register` takes `{email, password, fullName, phone?, smsConsent?, country?}`. Both return `{accessToken, refreshToken}`. A back-office account that must pass MFA gets `{mfaRequired, challengeToken, methods}` instead, and the app refuses it.
- **Phone OTP.** `POST /auth/phone/request-code` takes `{phone}`, which must include the country code. `POST /auth/phone/verify` takes `{phone, code: 6 digits, fullName?}` and returns the token pair plus `isNewAccount`.
- **Refresh and sign-out.** `POST /auth/refresh` takes `{refreshToken}` and rotates it; replaying a used token burns the whole token family. `POST /auth/logout` takes `{refreshToken}` and revokes it. `GET /auth/me` needs the bearer token.
- **Errors.**
  - A wrong password is a 401 `INVALID_CREDENTIALS`.
  - A bad refresh token is a 401 `INVALID_REFRESH_TOKEN`.
  - Validation errors are a 400 `VALIDATION_FAILED` with `details.fields`.
  - All auth routes are rate-limited (429).
- **Passwords.** Strength is judged by the server (`password-policy.ts`, minimum 10 characters). The app checks only that a request is well-formed and shows the server's own messages.

**How it works in the app**

| Piece                                   | File                              | What it does                                                                                                                                        |
| --------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeychainTokenStore`                    | `Core/Auth/TokenStore.swift`      | One Keychain item per environment. `AfterFirstUnlockThisDeviceOnly`, not synchronised, so no iCloud copy and no backup or restore to another device |
| `FreshInstallGuard`                     | same                              | Clears a session the Keychain kept from a previous install                                                                                          |
| `AuthSession` (actor)                   | `Core/Auth/AuthSession.swift`     | Holds the session, does one refresh at a time, and clears tokens only when the server rejects them                                                  |
| `APIClient`                             | `Core/Networking/APIClient.swift` | On a 401, refreshes once and retries once. Auth requests never carry a bearer token                                                                 |
| `RemoteAuthService` / `MockAuthService` | `Core/Auth/AuthService.swift`     | QA/PROD and MOCK adapters with the same API                                                                                                         |
| `AuthStore`                             | `Core/Auth/AuthStore.swift`       | The observable signed-in state for the UI; reacts when a session expires                                                                            |
| `SignInView`                            | `Features/Auth/SignInView.swift`  | Email sign-in and sign-up, mobile OTP, per-field server errors, AutoFill content types                                                              |

**Session behaviour**

- **One refresh at a time.** Concurrent 401s share a single refresh.
- **Expired sessions end cleanly.** If the refresh is rejected, the tokens are cleared and the UI says the session ended.
- **Offline keeps the session.** If the refresh fails on the network, the tokens are kept.
- **Sign-out always signs out.** It revokes the token on the server when it can, and always ends the local session, even offline.

**Write policy**

- **MOCK:** no network.
- **QA:** sign-in, sign-up, OTP and any later writes are allowed only for the exact identities in `QA_TEST_ACCOUNTS`: approved email addresses or E.164 numbers, with no wildcards. The real list goes in the git-ignored `Config/QA.local.xcconfig`, so test accounts stay out of source control. The committed default is empty, so nobody can sign in to QA.
- **PROD:** every non-GET request is refused, including sign-in, before anything is sent.

**MOCK credentials:** `demo.customer@example.com` / `Tickets-Demo-2026`; the mobile code is `123456`. The sign-in sheet shows these in MOCK builds only.

**Debug-only launch arguments** (compiled out of PROD): `-ETGSignIn` opens the sign-in sheet, and `-ETGMockSignedIn` starts MOCK signed in.

**Not in 2A:**

- Forgot and reset password (the routes exist).
- Attaching a phone to an existing account.
- Apple sign-in.
- MFA.
- Biometric unlock.

## Phase 2 plan

1. **Auth.** Done in 2A (above). Still to do: forgot and reset password, phone attach, and Sign in with Apple, which needs backend support.
2. **Live data on QA.** Run the Remote repositories against QA, then add contract tests that decode recorded QA responses.
   - Pass `city` to discovery.
   - Add pagination to Explore.
   - Load event images through `imageVariants`.
3. **Tickets.**
   - Offline cache with a 7-day limit, keyed per user, matching the Expo app's `etg.tickets.v1.<userId>`.
   - Screen brightness boost on the code view, restored when the app goes to the background.
   - Ticket detail via `/tickets/:id`.
   - Apple Wallet via `/wallet/passes`.
4. **Booking (QA only).**
   - Session picker, then seat map (`/public/shows/:id/seats`), then the server quote (`/bookings/quote`), then a hold via `POST /bookings` with an idempotency key, with a hold countdown.
   - Payment through the provider's hosted flow (`clientActionUrl`), then confirmation.
   - The PROD write guard is lifted only by an explicit, reviewed change.
5. **Platform.** APNs registration (`provider: apns`), universal links for `eticketsgo.com/events/:slug`, Sentry or crash reporting, and a privacy manifest.
6. **Quality.**
   - UI tests (XCUITest) for the main journeys.
   - Snapshot checks of the design system in light, dark and large type.
   - CI running `xcodebuild test` on macOS runners.
