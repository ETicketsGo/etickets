# Deep linking

## Scheme and hosts

- Custom scheme: `etickets://`
- Universal / app links: `https://<EXPO_PUBLIC_WEB_HOST>` (QA: `qa.eticketsgo.com`)
- Expo Go / dev client: `exp://`

## Supported routes

| Link                                 | Destination       | Auth |
| ------------------------------------ | ----------------- | ---- |
| `etickets://`                        | Home              | no   |
| `etickets://event/:slug`             | Event detail      | no   |
| `etickets://movie/:slug`             | Movie detail      | no   |
| `etickets://session/:id/seats?slug=` | Seat selection    | no   |
| `etickets://booking/:id`             | Booking + tickets | yes  |
| `etickets://tickets`                 | Tickets tab       | yes  |
| `etickets://search?q=`               | Search            | no   |
| `etickets://login?email=`            | Sign in           | no   |
| `etickets://register?email=`         | Register          | no   |

`etickets://booking/:id` doubles as the **payment return** target. The screen it lands on
re-reads the booking from the API; the return itself is never treated as proof of payment.

There is no password-reset link because the API has no reset endpoint.

## Validation

`src/services/deep-links.ts`. A deep link is untrusted input — anyone can put one in an
email, a QR code, or a web page.

- **Scheme allow-list.** `javascript:`, `file:`, `intent:`, `content:` and `data:` are
  rejected before parsing continues.
- **Host check on https links.** The host must equal `EXPO_PUBLIC_WEB_HOST` exactly.
  Without it, `https://qa.eticketsgo.com.evil.example/booking/…` would open a real
  booking screen from a phishing page. With no host configured, https links are refused
  entirely rather than accepted from anywhere.
- **Parameter shapes.** Ids must be identifier-shaped; slugs are anchored so they cannot
  smuggle a traversal or a scheme; search queries are bounded to 120 chars and stripped
  of control characters; an invalid email prefill is dropped.
- **Unknown paths fall back to Home**, never to what the URL suggested.
- **No external URL is ever returned for the app to open.** Building a redirector into a
  ticketing app is how phishing gets a trusted wrapper.

**An id in a URL is a claim, not a permission.** Resolution says only "this is a booking
route for this id". Whether the holder may see it is decided by the API. A test asserts
the resolution carries no authorization signal.

Rejections are silent — telling a sender which URLs the app parses is free reconnaissance.

## Auth-aware continuation

A link needing a session, opened while signed out, is held and replayed after sign-in
rather than lost at a login prompt (`src/hooks/use-deep-links.ts`).

Expo Router's own linking still matches paths against file routes; this layer sits in
front for the decisions the router cannot make. It is not claimed to replace it.

## Association files — OWNER ACTION, NOT DONE

Universal and app links are **not active**. Both require files served from the web host,
which is outside this app.

### Android — `https://<host>/.well-known/assetlinks.json`

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.eticketsgo.customer",
      "sha256_cert_fingerprints": ["<SHA-256 of the signing cert>"]
    }
  }
]
```

Get the fingerprint from `eas credentials` (or `keytool -list -v -keystore …`). The
package differs per profile: `.dev`, `.preview`, or no suffix for production — each
needs its own entry.

### iOS — `https://<host>/.well-known/apple-app-site-association`

Served as `application/json`, **no** `.json` extension, no redirects.

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "<TEAMID>.com.eticketsgo.customer",
        "paths": ["/event/*", "/movie/*", "/booking/*", "/tickets", "/search"]
      }
    ]
  }
}
```

Until both are served and verified, only `etickets://` links open the app; https links
open the website. Verify with Google's Digital Asset Links API and Apple's AASA
validator before claiming otherwise.
