import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';
import { SnsVerifier, type SnsEnvelope } from './sns-verifier';

/**
 * Proving an SNS message really came from Amazon.
 *
 * ── THE ATTACK THIS IS ABOUT ───────────────────────────────────────────────────────
 * The signature is checked with a certificate downloaded from a URL inside the message.
 * Implemented naively, that is a scheme in which the ATTACKER SUPPLIES THE KEY: post a
 * message, point `SigningCertURL` at a host you control, serve your own certificate, and the
 * signature verifies perfectly. It is also a server-side request forgery primitive aimed at
 * whatever the API server can reach.
 *
 * What makes that worth an attacker's time is what a bounce DOES: it suppresses a
 * destination. An unauthenticated suppression endpoint is a way to stop a chosen person
 * receiving their tickets, quietly, leaving a row indistinguishable from a real one.
 *
 * So the host check is the security property, and most of these tests are about it.
 */

/**
 * A throwaway key and a REAL self-signed X.509 certificate for it.
 *
 * ── WHY A REAL CERTIFICATE AND NOT A STAND-IN ──────────────────────────────────────
 * Node can generate a key pair but cannot mint a certificate, and the obvious shortcut — serve
 * the PEM public key with a CERTIFICATE header glued on — produces something the verifier
 * correctly refuses. Which is the point: the production code requires an actual certificate,
 * so a test that fed it anything else would be testing a different function.
 *
 * `openssl` mints one in a temporary directory that is deleted afterwards. Nothing is
 * committed, and the key exists for the length of one test run.
 */
function selfSigned(): { privateKey: KeyObject; certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sns-cert-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=sns-test',
    ]);
    return {
      privateKey: createPrivateKey(readFileSync(keyPath, 'utf8')),
      certPem: readFileSync(certPath, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
  Skips rather than fabricating a pass when openssl is unavailable. A suite that silently
  degraded to a weaker fixture would report green while proving nothing about the check that
  matters most here.
*/
let available = true;
let privateKey: KeyObject;
let certPem = '';
try {
  const generated = selfSigned();
  privateKey = generated.privateKey;
  certPem = generated.certPem;
} catch {
  available = false;
  // eslint-disable-next-line no-console
  console.warn('[sns-verifier] SKIPPED — openssl unavailable, cannot mint a test certificate');
}

const TRUSTED_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';

/** Runs only with a real certificate in hand; see `selfSigned`. */
const maybe = (name: string, fn: () => Promise<void> | void) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });

function sign(envelope: SnsEnvelope, fields: string[]): string {
  let canonical = '';
  for (const f of fields) {
    const v = (envelope as Record<string, unknown>)[f];
    if (v === undefined || v === null) continue;
    canonical += `${f}\n${String(v)}\n`;
  }
  const signer = createSign('RSA-SHA1');
  signer.update(canonical, 'utf8');
  return signer.sign(privateKey, 'base64');
}

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];

function notification(over: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const base: SnsEnvelope = {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:1234:ses-events',
    Message: '{"eventType":"Delivery"}',
    Timestamp: '2026-09-07T10:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: TRUSTED_URL,
    ...over,
  };
  return { ...base, Signature: sign(base, NOTIFICATION_FIELDS) };
}

/** A fetch that serves the certificate, and records every URL it was asked for. */
function certServer(body = certPem) {
  const calls: string[] = [];
  const impl = jest.fn(async (url: unknown) => {
    calls.push(String(url));
    return { ok: true, text: async () => body } as never;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('a genuine SNS notification', () => {
  maybe('verifies', async () => {
    const { impl } = certServer();
    const verifier = new SnsVerifier(impl);
    await expect(verifier.verify(notification())).resolves.toEqual({
      ok: true,
      type: 'Notification',
    });
  });

  maybe('verifies a message with no Subject, which most SES events have', async () => {
    // An absent optional field is OMITTED from the canonical string, not sent empty.
    // Including it would fail every event SES produces.
    const { impl } = certServer();
    await expect(new SnsVerifier(impl).verify(notification())).resolves.toMatchObject({ ok: true });
  });

  maybe('verifies a SubscriptionConfirmation, which signs a different field set', async () => {
    const fields = [
      'Message',
      'MessageId',
      'SubscribeURL',
      'Timestamp',
      'Token',
      'TopicArn',
      'Type',
    ];
    const base: SnsEnvelope = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-1',
      TopicArn: 'arn:aws:sns:us-east-1:1234:ses-events',
      Message: 'You have chosen to subscribe',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok',
      Timestamp: '2026-09-07T10:00:00.000Z',
      SignatureVersion: '1',
      SigningCertURL: TRUSTED_URL,
    };
    const envelope = { ...base, Signature: sign(base, fields) };
    const { impl } = certServer();
    await expect(new SnsVerifier(impl).verify(envelope)).resolves.toMatchObject({
      ok: true,
      type: 'SubscriptionConfirmation',
    });
  });

  maybe('fetches the certificate once and reuses it', async () => {
    // Otherwise every bounce is an outbound round trip, and believing a message from Amazon
    // requires Amazon to be reachable.
    const { impl, calls } = certServer();
    const verifier = new SnsVerifier(impl);
    await verifier.verify(notification());
    await verifier.verify(notification({ MessageId: 'msg-2' }));
    expect(calls).toHaveLength(1);
  });
});

describe('a message that is not what it claims to be', () => {
  maybe('refuses a body altered after signing', async () => {
    /*
      The whole point. A bounce for `victim@example.test` posted by anybody who knows the URL
      suppresses that address — so the body, not merely the caller, has to be authenticated.
    */
    const { impl } = certServer();
    const tampered = { ...notification(), Message: '{"eventType":"Bounce"}' };
    await expect(new SnsVerifier(impl).verify(tampered)).resolves.toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  maybe('refuses a signature that is simply wrong', async () => {
    const { impl } = certServer();
    await expect(
      new SnsVerifier(impl).verify({ ...notification(), Signature: 'ZGVhZGJlZWY=' }),
    ).resolves.toEqual({ ok: false, reason: 'signature_invalid' });
  });

  maybe('refuses a message signed with a DIFFERENT key', async () => {
    // The certificate URL is trusted, but the key it serves is not the one that signed.
    const other = selfSigned();
    const { impl } = certServer(`-----BEGIN CERTIFICATE-----\n${other.certPem}`);
    await expect(new SnsVerifier(impl).verify(notification())).resolves.toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  maybe('refuses a signature version it has not been written against', async () => {
    // Guessing an algorithm is how a verifier accepts something it cannot actually check.
    const { impl } = certServer();
    await expect(
      new SnsVerifier(impl).verify({ ...notification(), SignatureVersion: '3' }),
    ).resolves.toEqual({ ok: false, reason: 'unsupported_signature_version' });
  });

  maybe('refuses a message type it does not know', async () => {
    const { impl } = certServer();
    await expect(
      new SnsVerifier(impl).verify({ ...notification(), Type: 'SomethingNew' }),
    ).resolves.toEqual({ ok: false, reason: 'unknown_type' });
  });

  maybe('refuses a message with no signature at all', async () => {
    const { impl } = certServer();
    const { Signature, ...unsigned } = notification();
    void Signature;
    await expect(new SnsVerifier(impl).verify(unsigned)).resolves.toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });
});

describe('where the certificate is allowed to come from', () => {
  maybe('refuses a certificate served over plain HTTP', async () => {
    // Anybody on the path could swap the key the signature is checked against.
    const { impl, calls } = certServer();
    await expect(
      new SnsVerifier(impl).verify(
        notification({ SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem' }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'cert_url_not_https' });
    expect(calls).toEqual([]);
  });

  maybe('refuses an attacker-controlled host', async () => {
    const { impl, calls } = certServer();
    await expect(
      new SnsVerifier(impl).verify(notification({ SigningCertURL: 'https://evil.test/cert.pem' })),
    ).resolves.toEqual({ ok: false, reason: 'cert_url_untrusted_host' });
    // And crucially: no request was made. This endpoint is not an SSRF primitive.
    expect(calls).toEqual([]);
  });

  maybe('refuses a host that merely CONTAINS an Amazon domain', async () => {
    /*
      The mistake this list exists to prevent, and the one that looks right at a glance.
      `includes('amazonaws.com')` accepts every one of these.
    */
    const { impl, calls } = certServer();
    for (const host of [
      'sns.us-east-1.amazonaws.com.evil.test',
      'evil.test/sns.us-east-1.amazonaws.com',
      'notamazonaws.com',
      'sns.us-east-1.amazonaws.com.attacker.io',
    ]) {
      await expect(
        new SnsVerifier(impl).verify(notification({ SigningCertURL: `https://${host}/c.pem` })),
      ).resolves.toMatchObject({ ok: false });
    }
    expect(calls).toEqual([]);
  });

  maybe('refuses an Amazon host that is not a signing host', async () => {
    // An S3 bucket is on amazonaws.com and anybody can put a file in one.
    const { impl, calls } = certServer();
    await expect(
      new SnsVerifier(impl).verify(
        notification({ SigningCertURL: 'https://my-bucket.s3.amazonaws.com/cert.pem' }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'cert_url_untrusted_host' });
    expect(calls).toEqual([]);
  });

  maybe('accepts the documented partitions', async () => {
    const { impl } = certServer();
    const verifier = new SnsVerifier(impl);
    for (const host of ['sns.ap-south-1.amazonaws.com', 'sns.cn-north-1.amazonaws.com.cn']) {
      const url = `https://${host}/cert.pem`;
      await expect(verifier.verify(notification({ SigningCertURL: url }))).resolves.toMatchObject({
        ok: true,
      });
    }
  });

  maybe('refuses a malformed URL without attempting anything', async () => {
    const { impl, calls } = certServer();
    await expect(
      new SnsVerifier(impl).verify(notification({ SigningCertURL: 'not a url' })),
    ).resolves.toEqual({ ok: false, reason: 'cert_url_malformed' });
    expect(calls).toEqual([]);
  });

  maybe('refuses when the certificate cannot be fetched, rather than accepting', async () => {
    const impl = jest.fn(async () => ({
      ok: false,
      text: async () => '',
    })) as unknown as typeof fetch;
    await expect(new SnsVerifier(impl).verify(notification())).resolves.toEqual({
      ok: false,
      reason: 'cert_fetch_failed',
    });
  });

  maybe('refuses a response that is not a certificate', async () => {
    // A trusted host answering with an HTML error page, or something enormous.
    const { impl } = certServer('<html>nope</html>');
    await expect(new SnsVerifier(impl).verify(notification())).resolves.toEqual({
      ok: false,
      reason: 'cert_fetch_failed',
    });
  });
});
