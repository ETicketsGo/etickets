# Testing

## Layers and counts

| Layer                        | Location                | Count              | Runs in this environment? |
| ---------------------------- | ----------------------- | ------------------ | ------------------------- |
| Unit / contract              | `src/**/__tests__`      | 96 across 7 suites | Yes                       |
| Runtime smoke (web)          | `scripts/web-smoke.mjs` | 18 checks          | Yes                       |
| Component render             | —                       | 0                  | Not written               |
| Device E2E (Detox / Maestro) | —                       | 0                  | Needs a device            |

```bash
npm run test:mobile        # jest
npm run smoke:web          # export + Chromium against QA
```

## What the unit tests actually guard

| Suite                     | Guards                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cinema/seat-selection`   | Fail-closed on an unknown seat status; local selection never masks server state; booking lines keep `seatIds.length === quantity`; revalidation names the seats that were lost; per-order cap |
| `checkout/payment-action` | Relative vs https vs refused schemes; browser dismissal is not success                                                                                                                        |
| `services/ticket-cache`   | `qrToken` never written to disk; isolation between accounts; staleness; corrupt and truncated data; restore from disk only                                                                    |
| `services/deep-links`     | Scheme allow-list; host spoofing; path traversal; control characters; unknown → Home; no authorization implied                                                                                |
| `services/errors`         | No axios internals, status codes or endpoint names reach the user                                                                                                                             |
| `discovery/schema`        | Real captured QA payloads parse; malformed ones are rejected                                                                                                                                  |
| `application/auth-store`  | Hydrate / login / logout / expire; logout clears the ticket cache, expiry deliberately does not                                                                                               |

Fixtures are **real responses captured from QA**, trimmed — not invented shapes. That
matters: a fixture someone wrote from the type definition tests the type, not the API.

## The web smoke test

`npm run smoke:web` exports the bundle and drives it in Chromium at a 390×844 phone
viewport against the live QA API. It checks cold launch, discovery, live event titles
(which proves the API round-trip _and_ the Zod parse), all four tabs, search, the
signed-out tickets prompt, profile, event detail with real ticket types, movie routing to
reserved seating, the seat map and its legend, register, and unknown-route fallback. It
fails on any uncaught page error.

It proxies the API server-side rather than adding `localhost` to QA's `CORS_ORIGINS` —
weakening a deployed environment so a local test goes green is not a trade worth making.

It warms the API first: QA has app-sleeping enabled for cost, and one run scored 16/18
against a container that was still booting, then 18/18 seconds later.

**This is not device validation.** react-native-web substitutes DOM elements for native
views, so it exercises no native module (SecureStore, Brightness, Haptics,
Notifications), no real gesture handling, and no platform navigator.

## Not tested, stated plainly

- Anything on a real device or emulator — none is available here.
- Pinch and pan on the seat map; gesture-handler needs a native runtime.
- Screen-reader behaviour. Roles and labels are set throughout, but no VoiceOver or
  TalkBack pass has happened.
- Push delivery (no credentials).
- Universal / app links (association files not served).
- A real payment provider redirect (QA is mock-only, by design).
