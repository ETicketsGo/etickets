import type { SnsEnvelope } from './sns-verifier';
import {
  expectedSnsHost,
  parseTopicArn,
  redactedSubscribeUrl,
  validateSubscribeUrl,
} from './sns-subscribe-url';

/**
 * The one URL this platform will fetch because a message told it to.
 *
 * Every case here is a SubscriptionConfirmation that Amazon could have signed (the signature
 * covers SubscribeURL, but a signature says who wrote the bytes, not that the bytes are safe
 * to follow). Each refusal is a URL that would otherwise have been requested by the API
 * server: a different host, a different region, a different topic, a different action.
 */

const TOPIC = 'arn:aws:sns:ap-south-1:668506406280:eticketsgo-ses-events-prod';
const TOKEN = '2336412f37fb687f5d51e6e2425c464de12884ed1b53d26da6a5d7e0bd1d5ba7';
const GOOD = `https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=${TOKEN}`;

function envelope(over: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: 'm-1',
    TopicArn: TOPIC,
    Token: TOKEN,
    SubscribeURL: GOOD,
    Message: 'You have chosen to subscribe to the topic.',
    Timestamp: '2026-10-20T10:00:00.000Z',
    SignatureVersion: '1',
    ...over,
  };
}

const reason = (over: Partial<SnsEnvelope>) => {
  const v = validateSubscribeUrl(envelope(over));
  return v.ok ? 'ok' : v.reason;
};

describe('a genuine SubscribeURL', () => {
  it('is accepted, and the URL handed back is the one checked', () => {
    const v = validateSubscribeUrl(envelope());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.url.toString()).toBe(new URL(GOOD).toString());
    expect(v.region).toBe('ap-south-1');
  });

  it('is accepted whatever order the three parameters come in', () => {
    const reordered = `https://sns.ap-south-1.amazonaws.com/?Token=${TOKEN}&Action=ConfirmSubscription&TopicArn=${TOPIC}`;
    expect(reason({ SubscribeURL: reordered })).toBe('ok');
  });

  it('accepts a percent-encoded TopicArn, which decodes to the same ARN', () => {
    const encoded = GOOD.replace(TOPIC, encodeURIComponent(TOPIC));
    expect(reason({ SubscribeURL: encoded })).toBe('ok');
  });

  it('accepts the China partition on its own DNS suffix', () => {
    const cn = 'arn:aws-cn:sns:cn-north-1:123456789012:t';
    expect(
      reason({
        TopicArn: cn,
        SubscribeURL: `https://sns.cn-north-1.amazonaws.com.cn/?Action=ConfirmSubscription&TopicArn=${cn}&Token=${TOKEN}`,
      }),
    ).toBe('ok');
  });
});

describe('the host is the TopicArn region host, exactly', () => {
  it.each([
    ['a lookalike that only starts with the real host', 'sns.ap-south-1.amazonaws.com.evil.com'],
    ['an attacker host', 'evil.example'],
    ['another region than the topic', 'sns.us-east-1.amazonaws.com'],
    ['another AWS service host', 'sqs.ap-south-1.amazonaws.com'],
    ['a sub-domain of the real host', 'x.sns.ap-south-1.amazonaws.com'],
    ['the global, regionless host', 'sns.amazonaws.com'],
    ['a trailing dot', 'sns.ap-south-1.amazonaws.com.'],
  ])('refuses %s', (_label, host) => {
    expect(reason({ SubscribeURL: GOOD.replace('sns.ap-south-1.amazonaws.com', host) })).toBe(
      'subscribe_url_host_mismatch',
    );
  });

  it('refuses userinfo that makes the real host a username', () => {
    // `https://sns.ap-south-1.amazonaws.com@evil.example/` -- the host is evil.example.
    expect(
      reason({
        SubscribeURL: GOOD.replace(
          'sns.ap-south-1.amazonaws.com/',
          'sns.ap-south-1.amazonaws.com@evil.example/',
        ),
      }),
    ).toBe('subscribe_url_userinfo_or_port');
  });

  it('refuses userinfo in front of the real host', () => {
    expect(
      reason({
        SubscribeURL: GOOD.replace('https://', 'https://user:pass@'),
      }),
    ).toBe('subscribe_url_userinfo_or_port');
  });

  it('refuses an explicit port', () => {
    expect(reason({ SubscribeURL: GOOD.replace('amazonaws.com/', 'amazonaws.com:8443/') })).toBe(
      'subscribe_url_userinfo_or_port',
    );
  });

  it('refuses plain http', () => {
    expect(reason({ SubscribeURL: GOOD.replace('https://', 'http://') })).toBe(
      'subscribe_url_not_https',
    );
  });

  it('refuses a backslash trick, which a URL parser turns into a path', () => {
    expect(
      reason({ SubscribeURL: GOOD.replace('amazonaws.com/', 'amazonaws.com\\@evil.example/') }),
    ).toBe('subscribe_url_path');
  });

  it('refuses something that is not a URL at all', () => {
    expect(reason({ SubscribeURL: 'not a url' })).toBe('subscribe_url_malformed');
  });
});

describe('the request is ConfirmSubscription, for this topic and token, and nothing else', () => {
  it('refuses another Action', () => {
    expect(reason({ SubscribeURL: GOOD.replace('ConfirmSubscription', 'Unsubscribe') })).toBe(
      'subscribe_url_action',
    );
  });

  it('refuses a TopicArn in the URL that is not the message TopicArn', () => {
    const other = 'arn:aws:sns:ap-south-1:668506406280:somebody-elses-topic';
    expect(reason({ SubscribeURL: GOOD.replace(TOPIC, other) })).toBe(
      'subscribe_url_topic_mismatch',
    );
  });

  it('refuses a Token in the URL that is not the message Token', () => {
    expect(reason({ SubscribeURL: GOOD.replace(TOKEN, 'f'.repeat(64)) })).toBe(
      'subscribe_url_token_mismatch',
    );
  });

  it('refuses an extra parameter', () => {
    expect(reason({ SubscribeURL: `${GOOD}&Endpoint=https://evil.example` })).toBe(
      'subscribe_url_query',
    );
  });

  it('refuses a repeated parameter, whichever copy a server would read', () => {
    expect(reason({ SubscribeURL: `${GOOD}&Action=Unsubscribe` })).toBe('subscribe_url_query');
  });

  it('refuses a missing parameter', () => {
    expect(reason({ SubscribeURL: GOOD.replace(`&Token=${TOKEN}`, '') })).toBe(
      'subscribe_url_query',
    );
  });

  it('refuses any path other than /', () => {
    expect(
      reason({ SubscribeURL: GOOD.replace('amazonaws.com/?', 'amazonaws.com/redirect?') }),
    ).toBe('subscribe_url_path');
  });

  it('refuses a fragment', () => {
    expect(reason({ SubscribeURL: `${GOOD}#x` })).toBe('subscribe_url_path');
  });

  it('refuses a message with no SubscribeURL or no Token', () => {
    expect(reason({ SubscribeURL: undefined })).toBe('subscribe_url_missing');
    expect(reason({ Token: undefined })).toBe('subscribe_url_missing');
  });
});

describe('the TopicArn the host is built from', () => {
  it.each([
    ['not an ARN', 'eticketsgo-ses-events'],
    ['another service', 'arn:aws:sqs:ap-south-1:668506406280:q'],
    ['an unknown partition', 'arn:evil:sns:ap-south-1:668506406280:t'],
    ['a region that is a hostname', 'arn:aws:sns:evil.example:668506406280:t'],
    ['a region with a slash', 'arn:aws:sns:ap-south-1/x:668506406280:t'],
    ['a short account', 'arn:aws:sns:ap-south-1:1234:t'],
    ['too many parts', 'arn:aws:sns:ap-south-1:668506406280:t:extra'],
  ])('refuses %s', (_label, arn) => {
    expect(parseTopicArn(arn)).toBeNull();
    expect(reason({ TopicArn: arn })).toBe('topic_arn_malformed');
  });

  it('builds the regional host for each partition', () => {
    expect(expectedSnsHost(parseTopicArn(TOPIC)!)).toBe('sns.ap-south-1.amazonaws.com');
    expect(expectedSnsHost(parseTopicArn('arn:aws-us-gov:sns:us-gov-west-1:123456789012:t')!)).toBe(
      'sns.us-gov-west-1.amazonaws.com',
    );
  });
});

describe('the URL as recorded', () => {
  it('never contains the token', () => {
    const v = validateSubscribeUrl(envelope());
    if (!v.ok) throw new Error('expected ok');
    const recorded = redactedSubscribeUrl(v);
    expect(recorded).not.toContain(TOKEN);
    expect(recorded).toContain('Token=NOT-STORED');
    expect(new URL(recorded).hostname).toBe('sns.ap-south-1.amazonaws.com');
  });
});
