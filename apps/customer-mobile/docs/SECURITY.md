# Security

Controls that are actually implemented. Anything not listed here is not done.

## Credentials

- Refresh and access tokens live in the Keychain/Keystore (`expo-secure-store`), never in
  AsyncStorage. Web uses an in-memory store rather than localStorage — see
  [AUTHENTICATION.md](AUTHENTICATION.md).
- Reads and writes are failure-tolerant: an unreadable keychain means signed out, never a
  hung app.
- No payment provider key of any kind is in the app. See [PAYMENTS.md](PAYMENTS.md).
- `.env` is gitignored; only `.env.example` is committed, and it contains no values.

## The QR credential

`qrToken` is the signed payload the venue scanner verifies. The app:

- never renders it (a valid credential on screen is photographable by anyone nearby),
- never copies, logs or transmits it,
- **never writes it to disk** — it is stripped before caching, asserted by a test,
- never regenerates a QR from it; only the server's `qrDataUrl` is displayed.

Display components are typed against a credential-free shape so this cannot regress
quietly.

## Untrusted input

**Deep links.** Scheme allow-list, exact host match for https, per-parameter shape
validation, unknown paths fall back to Home, no external URL is ever opened. An id in a
link is a claim, not a permission — authorization is the API's. See
[DEEPLINKING.md](DEEPLINKING.md).

**Payment action URLs.** Relative paths go to our own API; absolute `https` opens the
system browser; everything else is refused. That URL arrives over the network, so
following an arbitrary scheme would let a spoofed response launch an intent of its
choosing.

**API responses.** Zod-parsed at the boundary. A drifted or hostile response fails in one
place with a handled error.

## Transport

HTTPS everywhere in QA and above. `env.ts` refuses to start a production build against a
missing or localhost API URL. `isLocalApiUrl` (shared-types) is the check.

## Logging

`ApiContractError` names the endpoint and the failing field paths but **never the
payload** — responses carry names, emails and booking references, and that string reaches
Sentry. `redactSecretKeys` exists in shared-types for the same reason.

Sentry is initialised only when a DSN is configured, and the backend's Sentry integration
already carries a PII scrubber.

## Not implemented

- Certificate pinning. Considered and not done: it breaks Railway's cert rotation and
  needs a native build to update. Reconsider before handling cards in-app — which, given
  the hosted-page model, is not currently planned.
- Jailbreak / root detection.
- Biometric gate on the ticket wallet.
- Encryption-at-rest of the ticket cache beyond the OS sandbox.
- Screenshot prevention on the ticket screen. (Of debatable value: people legitimately
  screenshot tickets, and the QR is displayed openly anyway.)
