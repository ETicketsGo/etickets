import { createVerify } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * Proving an SNS notification really came from Amazon.
 *
 * ── WHY THE PATH SECRET WAS NOT ENOUGH ─────────────────────────────────────────────
 * Phase 2 protected this endpoint with a secret in the URL and said, in writing, that it
 * authenticated the CALLER and not the BODY. That is a real distinction: anyone who learns
 * the URL — from a log line, a browser history, a copied runbook, an error report — can post
 * any bounce for any address, and what a bounce does is SUPPRESS a destination. An
 * unauthenticated suppression endpoint is a way to stop a chosen person receiving their
 * tickets, quietly, with no trace beyond a row that looks exactly like a real one.
 *
 * So the signature is now authoritative and the path secret is kept only as a cheap first
 * filter in front of it.
 *
 * ── WHY THIS IS WRITTEN OUT RATHER THAN TAKEN FROM A LIBRARY ───────────────────────
 * The AWS SDK in this repository is `@aws-sdk/client-sesv2`, which sends email; it does not
 * verify SNS messages, and `sns-validator` is not a dependency here. The verification itself
 * is thirty lines of standard RSA-SHA1/SHA256 over a canonical string — the part that is
 * genuinely dangerous is not the cryptography but the CERTIFICATE FETCH, and no library
 * removes the need to get that right.
 *
 * ── THE FOOTGUN, NAMED ─────────────────────────────────────────────────────────────
 * The signature is verified with a certificate downloaded from a URL inside the message.
 * Implemented naively that is a signature scheme where the attacker supplies the key: post a
 * message, point `SigningCertURL` at a host you control, serve your own certificate, and it
 * verifies perfectly. It is also a server-side request forgery primitive pointed at whatever
 * the API server can reach.
 *
 * The host check is therefore the whole security property, and it is done before any request
 * leaves this process: HTTPS only, and a hostname that is exactly `sns.<region>.amazonaws.com`
 * or one of the documented partition variants — matched against the END of the host with a
 * leading dot, never with `includes`, because `sns.us-east-1.amazonaws.com.evil.test` contains
 * the string and is not Amazon.
 */

/** Fields that are signed, in the order SNS signs them, per message type. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  Token?: string;
}

export type SnsVerdict = { ok: true; type: string } | { ok: false; reason: SnsRejection };

export type SnsRejection =
  | 'unknown_type'
  | 'unsupported_signature_version'
  | 'missing_signature'
  | 'cert_url_not_https'
  | 'cert_url_untrusted_host'
  | 'cert_url_malformed'
  | 'cert_fetch_failed'
  | 'signature_invalid';

/**
 * Amazon's SNS signing hosts.
 *
 * Matched as a suffix on a parsed hostname, with the leading dot included. `endsWith` on a
 * bare `amazonaws.com` would accept `notamazonaws.com`; `includes` would accept
 * `sns.us-east-1.amazonaws.com.attacker.test`. Both are the mistake this list exists to
 * avoid, and both look correct at a glance.
 */
const TRUSTED_SUFFIXES = [
  '.amazonaws.com',
  // AWS China and GovCloud publish under their own partitions.
  '.amazonaws.com.cn',
];

/** The host must also start with `sns.` — an S3 or EC2 host is not a signing host. */
function isTrustedSigningHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.startsWith('sns.')) return false;
  return TRUSTED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Injection token for the fetch implementation. Deliberately left unprovided in the module --
 * see the constructor.
 */
export const SNS_FETCH = Symbol('SNS_FETCH');

@Injectable()
export class SnsVerifier {
  private readonly logger = new Logger('NotificationWebhook');
  /**
   * Certificates, by URL.
   *
   * SNS rotates its signing certificate rarely, and fetching one per event would make every
   * bounce an outbound HTTPS round trip — and a dependency on Amazon being reachable in order
   * to believe a message Amazon sent. Bounded so a flood of messages naming distinct (but
   * still trusted) URLs cannot grow it without limit.
   */
  private readonly certs = new Map<string, string>();
  private static readonly MAX_CACHED_CERTS = 32;

  private readonly fetchImpl: typeof fetch;

  /**
   * Overridable for tests; production always fetches over HTTPS.
   *
   * -- WHY @Optional() @Inject(), AND NOT A DEFAULT PARAMETER --------------------------
   * A plain `fetchImpl: typeof fetch = fetch` looks like it needs no wiring, and every unit
   * test passes because they construct this class by hand. Nest does not read the default:
   * it sees a constructor parameter, asks for its type, gets `Function`, finds no provider
   * for it, and REFUSES TO START THE APPLICATION. The failure is at boot, not in any test
   * that exercises this file.
   *
   * A token nobody provides plus `@Optional()` gives the seam without the demand: Nest
   * passes undefined, and the fallback below is the production path.
   */
  constructor(@Optional() @Inject(SNS_FETCH) fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Is this message really from SNS?
   *
   * Every check that can be made WITHOUT a network call is made first, so a malformed or
   * hostile message never causes an outbound request at all.
   */
  async verify(envelope: SnsEnvelope): Promise<SnsVerdict> {
    const type = envelope.Type ?? '';
    const fields = SIGNED_FIELDS[type];
    if (!fields) return { ok: false, reason: 'unknown_type' };

    /*
      Version 1 is SHA1 and version 2 is SHA256; both are documented and both are accepted,
      because AWS still emits 1 on older topics and refusing it would silently drop real
      events. Anything else is a version this code has not been written against, and guessing
      an algorithm is how a verifier accepts something it cannot actually check.
    */
    const version = envelope.SignatureVersion;
    if (version !== '1' && version !== '2') {
      return { ok: false, reason: 'unsupported_signature_version' };
    }
    if (!envelope.Signature || !envelope.SigningCertURL) {
      return { ok: false, reason: 'missing_signature' };
    }

    let certUrl: URL;
    try {
      certUrl = new URL(envelope.SigningCertURL);
    } catch {
      return { ok: false, reason: 'cert_url_malformed' };
    }
    // Plain HTTP would let anybody on the path swap the key the signature is checked against.
    if (certUrl.protocol !== 'https:') return { ok: false, reason: 'cert_url_not_https' };
    if (!isTrustedSigningHost(certUrl.hostname)) {
      /*
        The one that matters. Without it, this is a signature scheme in which the attacker
        supplies the key — and an SSRF primitive pointed at whatever the API server can reach.
      */
      this.logger.warn(
        `SNS message named an untrusted signing host (${certUrl.hostname}); refused`,
      );
      return { ok: false, reason: 'cert_url_untrusted_host' };
    }

    const cert = await this.certificate(certUrl);
    if (!cert) return { ok: false, reason: 'cert_fetch_failed' };

    const canonical = this.canonicalString(envelope, fields);
    const algorithm = version === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
    try {
      const verifier = createVerify(algorithm);
      verifier.update(canonical, 'utf8');
      const valid = verifier.verify(cert, envelope.Signature, 'base64');
      return valid ? { ok: true, type } : { ok: false, reason: 'signature_invalid' };
    } catch {
      // A malformed certificate or signature. Indistinguishable from a forgery from here,
      // and treated as one.
      return { ok: false, reason: 'signature_invalid' };
    }
  }

  /**
   * The exact bytes SNS signed: each present field as `Name\nValue\n`, in the documented
   * order. Absent optional fields (`Subject`) are omitted entirely rather than sent empty —
   * including them would change the string and fail every message that has no subject.
   */
  private canonicalString(envelope: SnsEnvelope, fields: string[]): string {
    let out = '';
    for (const field of fields) {
      const value = (envelope as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      out += `${field}\n${String(value)}\n`;
    }
    return out;
  }

  private async certificate(url: URL): Promise<string | null> {
    const key = url.toString();
    const cached = this.certs.get(key);
    if (cached) return cached;

    try {
      const controller = new AbortController();
      // A signing host that hangs must not hold a webhook worker open indefinitely.
      const timer = setTimeout(() => controller.abort(), 5_000);
      let body: string;
      try {
        const res = await this.fetchImpl(key, { signal: controller.signal });
        if (!res.ok) return null;
        body = await res.text();
      } finally {
        clearTimeout(timer);
      }
      // A certificate is small. A host that answers with a gigabyte is not serving one.
      if (!body.includes('BEGIN CERTIFICATE') || body.length > 32_768) return null;

      if (this.certs.size >= SnsVerifier.MAX_CACHED_CERTS) {
        // Oldest out. Bounded rather than clever: rotation is rare and a strict LRU would be
        // machinery for a map that never legitimately exceeds a handful of entries.
        const oldest = this.certs.keys().next().value;
        if (oldest) this.certs.delete(oldest);
      }
      this.certs.set(key, body);
      return body;
    } catch {
      return null;
    }
  }
}
