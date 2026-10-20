import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { SnsEnvelope } from '../delivery/webhook/sns-verifier';

/**
 * Test support: a throwaway signing key, a REAL self-signed certificate for it, and SNS
 * messages signed exactly the way Amazon signs them.
 *
 * Never imported by application code. The certificate is minted by `openssl` in a temporary
 * directory that is deleted at once (Node can make a key pair but not a certificate, and the
 * verifier rightly refuses a bare public key). Returns null when openssl is unavailable so a
 * suite can SKIP rather than fabricate a pass.
 */
export function mintSnsTestCertificate(): { privateKey: KeyObject; certPem: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'sns-sign-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
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
      ],
      { stdio: 'ignore' },
    );
    return {
      privateKey: createPrivateKey(readFileSync(keyPath, 'utf8')),
      certPem: readFileSync(certPath, 'utf8'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The fields SNS signs, in order, per message type (the AWS-documented canonical form). */
export const SNS_SIGNED_FIELDS: Record<string, string[]> = {
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

/**
 * Sign an envelope. `algorithm` defaults to the one its SignatureVersion names (1 = SHA1,
 * 2 = SHA256); pass the other one to build a message whose version and signature disagree.
 */
export function signSnsEnvelope(
  envelope: SnsEnvelope,
  privateKey: KeyObject,
  algorithm?: 'RSA-SHA1' | 'RSA-SHA256',
): SnsEnvelope {
  const fields = SNS_SIGNED_FIELDS[envelope.Type ?? ''] ?? [];
  let canonical = '';
  for (const f of fields) {
    const v = (envelope as Record<string, unknown>)[f];
    if (v === undefined || v === null) continue;
    canonical += `${f}\n${String(v)}\n`;
  }
  const algo = algorithm ?? (envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  const signer = createSign(algo);
  signer.update(canonical, 'utf8');
  return { ...envelope, Signature: signer.sign(privateKey, 'base64') };
}

/** Amazon's ConfirmSubscription URL for a topic and token, as SNS writes it. */
export function snsSubscribeUrl(topicArn: string, token: string): string {
  const region = topicArn.split(':')[3];
  const suffix = topicArn.split(':')[1] === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  return (
    `https://sns.${region}.${suffix}/?Action=ConfirmSubscription` +
    `&TopicArn=${topicArn}&Token=${token}`
  );
}

/** What Amazon answers to a successful ConfirmSubscription. */
export function confirmSubscriptionResponse(topicArn: string): string {
  return (
    '<ConfirmSubscriptionResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">' +
    `<ConfirmSubscriptionResult><SubscriptionArn>${topicArn}:4f6d1c2e-0000-4000-8000-000000000001` +
    '</SubscriptionArn></ConfirmSubscriptionResult>' +
    '<ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId>' +
    '</ResponseMetadata></ConfirmSubscriptionResponse>'
  );
}
