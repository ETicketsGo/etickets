# Offline behaviour

## What works with no connection

| Works                                   | Notes                                   |
| --------------------------------------- | --------------------------------------- |
| Opening the app                         | Cold start does not require the network |
| Viewing already-synced upcoming tickets | Including the QR image                  |
| Booking detail for a cached ticket      | Labelled with its sync time             |
| Profile, support form UI, legal text    | Sending support needs a connection      |

## What does not

| Does not work                   | Why                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| Discovery, search, event detail | Live data; no snapshot is kept                                                             |
| Seat maps                       | Live shared inventory. A cached seat map is a picture of who had booked what a minute ago. |
| Creating a booking or paying    | Requires the server                                                                        |
| Past tickets                    | Deliberately dropped from the cache                                                        |
| Signing in                      | Requires the API                                                                           |

## The ticket cache

`src/services/ticket-cache.ts`.

**What is stored.** Upcoming tickets only, and `qrToken` is **stripped before anything
touches disk**. It is the signed credential the scanner verifies and the one field worth
stealing; the app needs `qrDataUrl` to put a picture on screen and nothing more. A test
asserts the token never appears in the written bytes, and the display components are
typed against a credential-free shape so nothing can start depending on it.

**Where.** AsyncStorage, not SecureStore. SecureStore is backed by the keychain and sized
for secrets — Android warns past ~2KB per value and a single base64 PNG QR exceeds that,
so a wallet would fail to save at exactly the wrong moment. The protection this data
actually has is the OS app sandbox plus full-disk encryption on a locked device. **A
rooted or jailbroken device can read it.** That is an accepted risk for a picture of a
QR code that is displayed openly at a gate anyway; it is recorded in
[THREAT-MODEL.md](THREAT-MODEL.md) rather than dressed up.

**Isolation.** Keys are namespaced by user id; the envelope carries the user id and is
rejected if it disagrees with the key; and the loaded cache is held together with the
user it belongs to so a mismatch is resolved during render — clearing in an effect
leaves one frame where the previous account's tickets are still in state.

**Freshness.** Every cached view is labelled with when it last synced. Past seven days it
says so more strongly and tells the user to reconnect before travelling. Live data always
wins the moment it arrives; the cache is only read while a request is in flight or after
it has failed.

**Clearing.** Logout wipes every account's cache on the device. Session expiry does not.

## The QR is the server's, always

The app renders `qrDataUrl` exactly as received. It never regenerates a code from
`qrToken`, because the token's encoding is what the venue scanner was built against and a
client-side QR library would be guessing at it — a guess that fails silently in testing
and loudly at a gate.

The app makes **no claim of dynamic or rotating QR validity offline**. `qrToken` is a
stored column, not a rotating code, so a cached image is as valid as a fresh one — but if
the server contract ever adds rotation, the cache must be revisited before it can be
trusted.

A ticket cancelled or refunded after the last sync will still render from disk. The
freshness label is the only thing standing between that and an argument at a gate, which
is why it is always shown and never suppressed.
