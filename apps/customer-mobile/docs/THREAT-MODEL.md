# Threat model

Scope: the customer mobile client. The API, payment providers and venue scanners have
their own models.

## Assets

| Asset                   | Why it matters                              |
| ----------------------- | ------------------------------------------- |
| Refresh / access tokens | Full account takeover                       |
| `qrToken`               | A valid entry credential — free admission   |
| Cached ticket data      | Names, event attendance, booking references |
| Buyer PII in checkout   | Name, email                                 |
| Payment session         | Money                                       |

## Adversaries and mitigations

### Someone with brief physical access to an unlocked phone

Can open the app and see tickets. **Accepted** — same as a paper ticket in a pocket. No
biometric gate on the wallet; adding one would put friction in front of the one action
people take in a queue.

### Someone with the device offline / in a backup

Tokens are in the Keychain/Keystore, protected by OS-level encryption. The ticket cache
is in AsyncStorage, protected by the app sandbox and full-disk encryption on a locked
device.

**Accepted risk: a rooted or jailbroken device can read the ticket cache.** Mitigated by
what is _not_ there — `qrToken` is never written, so the cache yields a QR image and
event metadata, not a forgeable credential. The image is displayed openly at a gate
anyway.

### A network attacker (hostile Wi-Fi, MITM)

HTTPS everywhere; production builds refuse a non-https/localhost API URL. **No
certificate pinning** — see [SECURITY.md](SECURITY.md) for why. A successful MITM with a
trusted root could read traffic; the residual is accepted for now given no card data
transits the app.

### A phishing link

The primary mitigation is the deep-link host check: an https link is only honoured if its
host matches the configured web host exactly, so look-alike domains cannot drive the app.
Non-web schemes are rejected. Nothing in the app opens an arbitrary external URL, so it
cannot be used as a trusted redirector.

### A compromised or spoofed API response

Zod parsing at the boundary. Specifically for payments: `clientActionUrl` is followed
only if relative or `https`; `javascript:`, `intent:`, `file:` and `http:` are refused —
otherwise a single tampered response could launch an arbitrary intent.

Specifically for seats: an unrecognised status fails **closed** (unselectable). Erring
that way costs a user one seat; erring the other way sells an occupied chair.

### Another app on the device

Standard OS sandboxing. The custom scheme `etickets://` can be claimed by another app on
Android — which is why https app links (once association files are served) are the
stronger channel, and why nothing sensitive is ever passed _in_ a link. A link carries
ids, and an id is not a permission.

### A malicious or curious user of the app itself

Cannot forge a ticket: the QR comes from the server and is signed server-side. Cannot
manipulate a price: totals come from the API's fee breakdown, never from client
arithmetic. Cannot take a held seat: the server rejects it and the app re-validates
before booking.

## Residual risks, accepted and recorded

1. Ticket cache readable on a rooted device (credential excluded).
2. No certificate pinning.
3. No root/jailbreak detection.
4. Web build keeps tokens in memory only — a preview surface, not shipped.
5. Association files not yet served, so https links do not open the app.
