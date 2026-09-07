import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proving a delivery callback came from the provider that claims to have sent it.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ────────────────────────────────────────────
 * These endpoints are public — a provider cannot authenticate to them — and what they accept
 * changes a notification's recorded state and can SUPPRESS a destination. An unauthenticated
 * endpoint would let anyone post a hard bounce for any address and quietly stop that person
 * receiving their tickets. Suppression is a denial-of-service primitive if it can be reached
 * without a signature.
 *
 * ── WHAT EACH PROVIDER OFFERS ──────────────────────────────────────────────────────
 * Twilio     HMAC-SHA1 over the URL plus the sorted form fields, base64.
 * Meta Cloud HMAC-SHA256 over the raw body, hex, as `sha256=…`.
 * SES/SNS    RSA-SHA1 over a canonical string, signed with a certificate SNS publishes.
 * MSG91      Nothing published. See {@link verifySharedSecret}.
 */

/** Constant-time compare that also refuses length-mismatched inputs without leaking. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Twilio's scheme: the full request URL, then every POST field appended as key+value in
 * lexicographic key order, HMAC-SHA1 with the account auth token, base64.
 *
 * The URL is part of the signature, which is why it has to be the URL Twilio actually called
 * — behind a proxy that means the public one, not what Express reconstructs from a rewritten
 * Host header.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
  signature: string,
): boolean {
  if (!authToken || !signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ''), url);
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  return safeEqual(expected, signature);
}

/**
 * Meta's scheme: HMAC-SHA256 of the RAW body with the app secret, presented as `sha256=<hex>`.
 *
 * Raw bytes, not the re-serialised object: `JSON.stringify(JSON.parse(body))` is not
 * byte-identical to what was sent, so verifying against a parsed body fails on any payload
 * whose key order or number formatting differs.
 */
export function verifyMetaSignature(appSecret: string, rawBody: string, header: string): boolean {
  if (!appSecret || !header) return false;
  const expected =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(expected, header);
}

/**
 * A shared secret in the callback URL, for a provider that publishes no signing scheme.
 *
 * ── WHY THIS IS WEAKER, AND SAID SO PLAINLY ────────────────────────────────────────
 * MSG91 documents no signature on its delivery reports. The available options are then: a
 * secret embedded in the callback URL registered in their dashboard, an IP allowlist, or
 * nothing. A URL secret is not a signature — it does not authenticate the BODY, so anyone who
 * learns the URL can post any status for any message id they can guess.
 *
 * It is chosen because it is strictly better than nothing and needs no infrastructure. Two
 * things keep the blast radius small: the secret is compared in constant time, and MSG91
 * events can only ever advance a delivery's state, never suppress an address they do not
 * already have a delivery row for.
 *
 * If MSG91 later publishes a signing scheme, this is the one place to replace.
 */
export function verifySharedSecret(expected: string | undefined, supplied: string): boolean {
  if (!expected) return false;
  return safeEqual(expected, supplied);
}

/**
 * Whether an SNS message envelope is one this platform will act on.
 *
 * ── WHY THE SIGNATURE IS NOT VERIFIED HERE ─────────────────────────────────────────
 * SNS signs with RSA-SHA1 over a canonical string, using a certificate fetched from a URL in
 * the message itself. Verifying it properly means an outbound HTTPS fetch of that certificate,
 * a strict check that its host is a genuine AWS signing host — the check people forget, and
 * the one that makes the whole scheme worthless when skipped — and a cache so every event does
 * not become a network round trip.
 *
 * That is a real piece of work with a real footgun, and it is not something to half-build. So
 * this endpoint is protected the same way MSG91's is: a shared secret in the callback URL,
 * which AWS supports because the subscription endpoint is configured once in the SNS console.
 * The topic can also be locked to this endpoint by subscription policy.
 *
 * Documented as a limitation rather than presented as verification. See ADR-046 and the
 * EXTERNAL SETUP section of PROVIDER-ROUTING.md.
 */
export function snsMessageType(headers: Record<string, unknown>, body: unknown): string | null {
  const header = headers['x-amz-sns-message-type'];
  if (typeof header === 'string' && header) return header;
  const inBody = (body as { Type?: unknown } | null)?.Type;
  return typeof inBody === 'string' ? inBody : null;
}
