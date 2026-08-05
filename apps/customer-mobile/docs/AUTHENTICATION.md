# Authentication

## Model

Email + password against the existing API. Access + refresh token pair, rotated on
refresh. No social login — none is implemented server-side, and faking a provider button
that cannot work is worse than not having one.

## Storage

| Platform      | Where                                       | Why             |
| ------------- | ------------------------------------------- | --------------- |
| iOS / Android | Keychain / Keystore via `expo-secure-store` | Hardware-backed |
| Web           | In-memory only                              | See below       |

Web gets an in-memory store deliberately. `expo-secure-store` has no web build at all
(it throws `getValueWithKeyAsync is not a function`), and the obvious substitute —
localStorage — exposes a refresh token to any XSS on the origin. Web is a preview and
smoke-test surface, not a shipping target, so forgetting the session on reload is the
right trade.

Every read and write is failure-tolerant. An unreadable keychain means "signed out",
never "cannot start" — which matters on device too: a restored backup, or a keystore
entry invalidated by a biometric change.

## Hydration

`app/_layout.tsx` holds the splash screen until the session resolves. `hydrate()` is
therefore guarded end to end: **any** throw in it means the app never paints. This is
not defensive habit — it happened, and the app rendered a blank page until it was found
by running the exported bundle in a browser.

## Refresh

`src/services/api-client.ts` intercepts 401, performs a single-flight refresh against
`POST /auth/refresh`, and retries once. Auth endpoints are excluded from the retry so a
failing refresh cannot recurse. On failure the store is cleared and the UI drops to
signed-out.

A session that merely **expires** does not clear cached tickets — the usual cause is a
phone that has been offline, which is exactly when someone needs the ticket they already
downloaded. A deliberate **logout** wipes every account's cache on the device.

## What requires an account

Browsing does not. The API serves discovery publicly and supports guest checkout, and a
sign-in wall as the first screen is a conversion loss.

| Area                                            | Requires auth                 |
| ----------------------------------------------- | ----------------------------- |
| Discovery, search, event detail, seat selection | No                            |
| Checkout                                        | No (guest checkout supported) |
| Tickets tab, booking detail                     | Yes                           |
| Profile identity block, logout                  | Yes                           |

`AuthGate` renders a sign-in prompt **in place** rather than redirecting, so signing in
returns the user to what they were doing instead of resetting them to Home.
