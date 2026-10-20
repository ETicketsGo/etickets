import type { SnsEnvelope } from './sns-verifier';

/**
 * Deciding whether a SubscribeURL is the one URL this platform will ever fetch on SNS's say-so.
 *
 * ── WHY THE URL IS CHECKED WHEN THE MESSAGE IS ALREADY SIGNED ──────────────────────
 * A verified signature proves Amazon produced these bytes. It does not prove that following
 * the URL inside them does what we think: the field is free text as far as this process is
 * concerned, and "fetch whatever URL a message names" is a server-side request forgery
 * primitive however trustworthy the message is. So the URL is held to the exact shape of
 * Amazon's ConfirmSubscription call, for the exact topic the message names, and anything else
 * is refused before a socket is opened. The fetch in SnsConfirmationService takes its URL
 * only from here.
 *
 * ── THE SHAPE, AND WHERE EACH RULE COMES FROM ──────────────────────────────────────
 *   https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=<arn>&Token=<t>
 *
 * - https, no username, password or port: nothing Amazon sends carries them.
 * - host EXACTLY `sns.<region>.<dns suffix>`, built from the TopicArn rather than matched
 *   against a pattern, so `sns.us-east-1.amazonaws.com.evil.test` and a different region's
 *   endpoint are refused for the same reason: they are not the string we built.
 * - path `/`, no fragment.
 * - query: exactly the three parameters, each once. `Action` is `ConfirmSubscription`, and
 *   `TopicArn` and `Token` equal the message's own signed fields, so the URL cannot confirm a
 *   different topic than the one the allowlist approved.
 */

export type SubscribeUrlRejection =
  | 'topic_arn_malformed'
  | 'subscribe_url_missing'
  | 'subscribe_url_malformed'
  | 'subscribe_url_not_https'
  | 'subscribe_url_userinfo_or_port'
  | 'subscribe_url_host_mismatch'
  | 'subscribe_url_path'
  | 'subscribe_url_query'
  | 'subscribe_url_action'
  | 'subscribe_url_topic_mismatch'
  | 'subscribe_url_token_mismatch';

export type SubscribeUrlVerdict =
  | { ok: true; url: URL; topicArn: string; token: string; region: string }
  | { ok: false; reason: SubscribeUrlRejection };

/** The DNS suffix of each AWS partition SNS runs in. Anything else is refused. */
const PARTITION_DNS: Record<string, string> = {
  aws: 'amazonaws.com',
  'aws-us-gov': 'amazonaws.com',
  'aws-cn': 'amazonaws.com.cn',
};

/** A region name: `us-east-1`, `ap-south-1`, `us-gov-west-1`, `cn-north-1`. */
const REGION = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d+$/;

/**
 * `arn:<partition>:sns:<region>:<account>:<topic>`, split; null when it is not one.
 *
 * Strict on purpose: the region taken from here becomes part of the only hostname this
 * process will call, so a value that is not plainly a region must never get that far.
 */
export function parseTopicArn(
  arn: string | undefined,
): { partition: string; region: string; account: string; topic: string } | null {
  if (!arn) return null;
  const parts = arn.split(':');
  if (parts.length !== 6) return null;
  const [prefix, partition, service, region, account, topic] = parts;
  if (prefix !== 'arn' || service !== 'sns') return null;
  if (!(partition in PARTITION_DNS)) return null;
  if (!REGION.test(region)) return null;
  if (!/^\d{12}$/.test(account)) return null;
  if (!/^[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/.test(topic)) return null;
  return { partition, region, account, topic };
}

/** The one host a confirmation for this topic may be sent to. */
export function expectedSnsHost(arn: { partition: string; region: string }): string {
  return `sns.${arn.region}.${PARTITION_DNS[arn.partition]}`;
}

/**
 * Validate a (signature-verified) SubscriptionConfirmation's SubscribeURL.
 *
 * Pure and synchronous: it cannot make a request, so calling it can never be the request.
 */
export function validateSubscribeUrl(envelope: SnsEnvelope): SubscribeUrlVerdict {
  const arn = parseTopicArn(envelope.TopicArn);
  if (!arn || !envelope.TopicArn) return { ok: false, reason: 'topic_arn_malformed' };
  const raw = envelope.SubscribeURL;
  const token = envelope.Token;
  if (!raw || !token) return { ok: false, reason: 'subscribe_url_missing' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'subscribe_url_malformed' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'subscribe_url_not_https' };
  if (url.username || url.password || url.port) {
    return { ok: false, reason: 'subscribe_url_userinfo_or_port' };
  }
  // `URL` lower-cases the host, so this is an exact, case-insensitive comparison of the whole
  // hostname -- not a prefix, suffix or substring test.
  if (url.hostname !== expectedSnsHost(arn)) {
    return { ok: false, reason: 'subscribe_url_host_mismatch' };
  }
  if (url.pathname !== '/' || url.hash) return { ok: false, reason: 'subscribe_url_path' };

  const keys = [...url.searchParams.keys()];
  const expectedKeys = ['Action', 'Token', 'TopicArn'];
  if (keys.length !== expectedKeys.length || [...keys].sort().join() !== expectedKeys.join()) {
    // A missing, repeated or extra parameter. Amazon sends these three, once each.
    return { ok: false, reason: 'subscribe_url_query' };
  }
  if (url.searchParams.get('Action') !== 'ConfirmSubscription') {
    return { ok: false, reason: 'subscribe_url_action' };
  }
  if (url.searchParams.get('TopicArn') !== envelope.TopicArn) {
    return { ok: false, reason: 'subscribe_url_topic_mismatch' };
  }
  if (url.searchParams.get('Token') !== token) {
    return { ok: false, reason: 'subscribe_url_token_mismatch' };
  }
  return { ok: true, url, topicArn: envelope.TopicArn, token, region: arn.region };
}

/**
 * The URL with its token replaced, for the one place a URL is recorded at all.
 *
 * Built from the validated parts rather than by editing the original string, so the result
 * can only ever be the three known parameters.
 */
export function redactedSubscribeUrl(verdict: { url: URL; topicArn: string }): string {
  const out = new URL(`https://${verdict.url.hostname}/`);
  out.searchParams.set('Action', 'ConfirmSubscription');
  out.searchParams.set('TopicArn', verdict.topicArn);
  out.searchParams.set('Token', 'NOT-STORED');
  return out.toString();
}
