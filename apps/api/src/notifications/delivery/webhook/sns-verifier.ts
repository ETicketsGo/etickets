import { createVerify } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
  | 'signature_invalid'
  | 'topic_not_allowed';

/**
 * Amazon's SNS signing hosts: exactly `sns.<region>.amazonaws.com`, or `.amazonaws.com.cn` for
 * the China partition. GovCloud regions (`us-gov-west-1`) and ISO regions are covered by the
 * region pattern.
 *
 * ── WHY A WHOLE-HOST PATTERN AND NOT A PREFIX PLUS A SUFFIX ────────────────────────
 * The previous check was `startsWith('sns.')` and `endsWith('.amazonaws.com')`, which rejects
 * `sns.us-east-1.amazonaws.com.attacker.test` but accepts `sns.s3.amazonaws.com` — an S3 bucket
 * named `sns`, which anybody can create and serve their own certificate from. Anchoring the
 * middle label to the shape of a region name closes that: `s3` is not a region, and neither is
 * any bucket or service hostname.
 */
const TRUSTED_SIGNING_HOST =
  /^sns\.[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d+\.amazonaws\.com(?:\.cn)?$/;

function isTrustedSigningHost(hostname: string): boolean {
  return TRUSTED_SIGNING_HOST.test(hostname.toLowerCase());
}

/** `SES_SNS_TOPIC_ARNS`, comma-separated, as a set; null when unset or blank. */
function parseTopicArns(raw: string | undefined): Set<string> | null {
  const arns = (raw ?? '')
    .split(',')
    .map((arn) => arn.trim())
    .filter(Boolean);
  return arns.length > 0 ? new Set(arns) : null;
}

/**
 * Injection token for the fetch implementation. Deliberately left unprovided in the module --
 * see the constructor.
 */
export const SNS_FETCH = Symbol('SNS_FETCH');

@Injectable()
export class SnsVerifier implements OnModuleInit {
  private readonly logger = new Logger('NotificationWebhook');
  /**
   * The SNS topics SES events may come from, when configured.
   *
   * A valid signature proves AMAZON sent the message, not that it came from OUR topic: anybody
   * with an AWS account can create a topic, subscribe this URL to it, and publish correctly
   * signed bounces. The path secret stands in front of that today; the allowlist removes it as
   * a way in. Optional because QA does not have its topic ARN configured yet — see onModuleInit.
   */
  private readonly allowedTopics: Set<string> | null;
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
  constructor(
    @Optional() @Inject(SNS_FETCH) fetchImpl?: typeof fetch,
    @Optional() private readonly config?: ConfigService,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.allowedTopics = parseTopicArns(config?.get<string>('SES_SNS_TOPIC_ARNS'));
  }

  /**
   * Said once, at boot, where it matters: a deployed environment that receives SES events and
   * accepts them from any correctly signed topic. A warning rather than a refusal, because
   * requiring it would stop QA booting before anybody has had the chance to look its ARN up.
   */
  onModuleInit(): void {
    if (this.allowedTopics || !this.config) return;
    const appEnv = (this.config.get<string>('APP_ENV') ?? '').toUpperCase();
    if (!['QA', 'UAT', 'STAGING', 'PRODUCTION'].includes(appEnv)) return;
    const receivesSesEvents =
      Boolean(this.config.get<string>('SES_WEBHOOK_SECRET')) ||
      this.config.get<string>('EMAIL_PROVIDER') === 'ses';
    if (!receivesSesEvents) return;
    this.logger.warn(
      `SES_SNS_TOPIC_ARNS is not set in ${appEnv}: SES events are accepted from ANY SNS topic ` +
        'Amazon has signed, not only this environment’s. Set it to the SES event topic ARN(s).',
    );
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
    /*
      Checked before the certificate is fetched: it costs nothing, and a message from a topic
      we never subscribed to is refused whether or not Amazon signed it. `TopicArn` is itself a
      signed field, so it cannot be swapped for an allowed one after signing.
    */
    if (this.allowedTopics && !this.allowedTopics.has(envelope.TopicArn ?? '')) {
      return { ok: false, reason: 'topic_not_allowed' };
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
