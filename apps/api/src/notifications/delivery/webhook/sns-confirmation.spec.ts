import { Logger } from '@nestjs/common';
import { SnsVerifier, type SnsEnvelope } from './sns-verifier';
import { SnsConfirmationService } from './sns-confirmation.service';
import { confirmSubscriptionResponse, snsSubscribeUrl } from '../../test-support/sns-signing';

/**
 * Confirming the SES event subscription automatically (ADR-054), checked one rule at a time.
 *
 * The caller (the webhook) has already verified the path secret and the SNS signature; these
 * tests start from there. The assertion that matters in each refusal is the number of
 * outbound requests: ZERO. A refusal that still fetched would be the SSRF this design exists
 * to prevent. The assertion that matters in each success is ONE request, to exactly the URL
 * that was validated, with redirects off.
 *
 * Every rule is run with APP_ENV=PRODUCTION as well as QA, because production is the
 * environment where the manual step this replaces could not be done at all.
 */

const TOPIC = 'arn:aws:sns:ap-south-1:668506406280:eticketsgo-ses-events-prod';
const OTHER_TOPIC = 'arn:aws:sns:ap-south-1:999999999999:attacker-topic';
const TOKEN = 'a3f9c1d27e5b4a6f8091b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b';
const GOOD_URL = snsSubscribeUrl(TOPIC, TOKEN);

type Row = Record<string, unknown> & { id: string; status: string };

/** Just enough of Prisma's snsPendingConfirmation for the service: an in-memory table. */
function fakePrisma() {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const cond = v as { not?: unknown; lt?: Date };
        if ('not' in cond) return row[k] !== cond.not;
        if ('lt' in cond) return row[k] instanceof Date && (row[k] as Date) < cond.lt!;
      }
      return row[k] === v || (v === null && row[k] == null);
    });
  const apply = (row: Row, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) {
        row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
      } else row[k] = v;
    }
  };
  return {
    rows,
    snsPendingConfirmation: {
      findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const found = rows.filter((r) => !where || matches(r, where));
        return found.length ? found[found.length - 1] : null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `row-${++seq}`,
          status: 'PENDING',
          attemptCount: 0,
          lastAttemptAt: null,
          ...data,
        } as Row;
        rows.push(row);
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => apply(r, data));
          return { count: hit.length };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          apply(row, data);
          return row;
        },
      ),
    },
  };
}

/** A stand-in for Amazon's SNS endpoint that records every request it is asked to make. */
function amazon(respond?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (respond) return respond(String(url), init);
    return new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function harness(opts: {
  appEnv?: string;
  allowlist?: string | undefined;
  fetch?: ReturnType<typeof amazon>;
}) {
  const values: Record<string, string | undefined> = {
    APP_ENV: opts.appEnv ?? 'PRODUCTION',
    SES_SNS_TOPIC_ARNS: 'allowlist' in opts ? opts.allowlist : TOPIC,
  };
  const config = { get: (k: string) => values[k] };
  const prisma = fakePrisma();
  const audits: Record<string, unknown>[] = [];
  const audit = { record: jest.fn(async (e: Record<string, unknown>) => void audits.push(e)) };
  const net = opts.fetch ?? amazon();
  const verifier = new SnsVerifier(undefined, config as never);
  const service = new SnsConfirmationService(
    prisma as never,
    config as never,
    audit as never,
    verifier,
    net.impl,
  );
  return { service, prisma, audits, net };
}

function confirmation(over: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: 'msg-confirm-1',
    TopicArn: TOPIC,
    Token: TOKEN,
    SubscribeURL: GOOD_URL,
    Message: 'You have chosen to subscribe to the topic.',
    Timestamp: '2026-10-20T10:00:00.000Z',
    SignatureVersion: '1',
    ...over,
  };
}

/** Everything the Nest logger was asked to write, so a test can prove the token never was. */
function captureLogs() {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

beforeEach(() => {
  // Quiet by default; captureLogs() replaces these where a test reads the lines.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe.each(['PRODUCTION', 'QA'])('APP_ENV=%s: a valid confirmation', (appEnv) => {
  it('calls the SubscribeURL exactly once, without following redirects', async () => {
    const h = harness({ appEnv });
    await expect(h.service.handle(confirmation())).resolves.toEqual({ kind: 'confirmed' });
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0].url).toBe(new URL(GOOD_URL).toString());
    expect(h.net.calls[0].init?.redirect).toBe('manual');
    expect(h.net.calls[0].init?.signal).toBeDefined();
  });

  it('records the outcome: CONFIRMED, the SubscriptionArn, and the token only as a hash', async () => {
    const h = harness({ appEnv });
    await h.service.handle(confirmation());
    expect(h.prisma.rows).toHaveLength(1);
    const row = h.prisma.rows[0];
    expect(row.status).toBe('CONFIRMED');
    expect(String(row.subscriptionArn).startsWith(`${TOPIC}:`)).toBe(true);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it('writes an audit entry that names the topic and not the URL, token or SubscriptionArn', async () => {
    const h = harness({ appEnv });
    await h.service.handle(confirmation());
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'SNS_SUBSCRIPTION_CONFIRMED',
      metadata: { topicArn: TOPIC, appEnv, automatic: true },
    });
    const text = JSON.stringify(h.audits);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(`${TOPIC}:`);
  });

  it('never writes the token or the SubscribeURL to a log', async () => {
    jest.restoreAllMocks();
    const lines = captureLogs();
    const h = harness({ appEnv });
    await h.service.handle(confirmation());
    await h.service.handle(confirmation());
    await h.service.handle(
      confirmation({ TopicArn: OTHER_TOPIC, SubscribeURL: snsSubscribeUrl(OTHER_TOPIC, TOKEN) }),
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('Action=');
    }
  });

  it('is a no-op the second time: same topic and token, no second request', async () => {
    const h = harness({ appEnv });
    await h.service.handle(confirmation());
    await expect(h.service.handle(confirmation())).resolves.toEqual({
      kind: 'already_confirmed',
    });
    // A replay under a different MessageId is recognised by the token, not the id.
    await expect(h.service.handle(confirmation({ MessageId: 'msg-replayed' }))).resolves.toEqual({
      kind: 'already_confirmed',
    });
    expect(h.net.calls).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('does not call Amazon twice while an attempt is already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = amazon(async () => {
      await gate;
      return new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
    });
    const h = harness({ appEnv, fetch: net });
    const first = h.service.handle(confirmation());
    // Let the first request take its lease before the second arrives.
    await new Promise((r) => setTimeout(r, 10));
    await expect(h.service.handle(confirmation())).resolves.toEqual({ kind: 'in_progress' });
    release();
    await expect(first).resolves.toEqual({ kind: 'confirmed' });
    expect(net.calls).toHaveLength(1);
  });
});

type RefusalCase = [string, Partial<SnsEnvelope>, { allowlist?: string | undefined }, string];

const REFUSALS: RefusalCase[] = [
  ['the allowlist is unset', {}, { allowlist: undefined }, 'topic_allowlist_unset'],
  ['the allowlist is blank', {}, { allowlist: '  ' }, 'topic_allowlist_unset'],
  [
    'the topic is not on the allowlist',
    { TopicArn: OTHER_TOPIC, SubscribeURL: snsSubscribeUrl(OTHER_TOPIC, TOKEN) },
    {},
    'topic_not_allowed',
  ],
  [
    'the topic only differs by a suffix',
    { TopicArn: `${TOPIC}-x`, SubscribeURL: snsSubscribeUrl(`${TOPIC}-x`, TOKEN) },
    {},
    'topic_not_allowed',
  ],
  [
    'the SubscribeURL host is another region',
    { SubscribeURL: GOOD_URL.replace('sns.ap-south-1.', 'sns.us-east-1.') },
    {},
    'subscribe_url_host_mismatch',
  ],
  [
    'the SubscribeURL host is a lookalike',
    {
      SubscribeURL: GOOD_URL.replace(
        'sns.ap-south-1.amazonaws.com',
        'sns.ap-south-1.amazonaws.com.evil.com',
      ),
    },
    {},
    'subscribe_url_host_mismatch',
  ],
  [
    'the SubscribeURL names another topic',
    { SubscribeURL: snsSubscribeUrl(OTHER_TOPIC, TOKEN) },
    {},
    'subscribe_url_topic_mismatch',
  ],
  [
    'the SubscribeURL Action is not ConfirmSubscription',
    { SubscribeURL: GOOD_URL.replace('ConfirmSubscription', 'Subscribe') },
    {},
    'subscribe_url_action',
  ],
  [
    'the SubscribeURL is http',
    { SubscribeURL: GOOD_URL.replace('https:', 'http:') },
    {},
    'subscribe_url_not_https',
  ],
  [
    'the SubscribeURL carries userinfo',
    { SubscribeURL: GOOD_URL.replace('https://', 'https://u:p@') },
    {},
    'subscribe_url_userinfo_or_port',
  ],
];

describe.each(['PRODUCTION', 'QA'])('APP_ENV=%s: refused before any request', (appEnv) => {
  it.each(REFUSALS)('when %s', async (_label, over, opts, reason) => {
    const h = harness({ appEnv, ...opts });
    await expect(h.service.handle(confirmation(over))).resolves.toEqual({
      kind: 'refused',
      reason,
    });
    expect(h.net.calls).toHaveLength(0);
    // Nothing written: a refused message leaves no row and no audit entry.
    expect(h.prisma.rows).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

describe("when Amazon's answer is not a confirmation", () => {
  it('does not follow a redirect: one request, the Location never fetched, not confirmed', async () => {
    const net = amazon(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    const h = harness({ fetch: net });
    await expect(h.service.handle(confirmation())).resolves.toEqual({
      kind: 'failed',
      reason: 'redirect_refused',
    });
    expect(net.calls.map((c) => c.url)).toEqual([new URL(GOOD_URL).toString()]);
    expect(h.prisma.rows[0].status).toBe('PENDING');
  });

  it('treats an opaque redirect (what fetch returns for redirect: manual) the same way', async () => {
    const net = amazon(() => ({ type: 'opaqueredirect', status: 0 }) as unknown as Response);
    const h = harness({ fetch: net });
    await expect(h.service.handle(confirmation())).resolves.toMatchObject({
      reason: 'redirect_refused',
    });
  });

  it('gives up after its timeout instead of holding the webhook open', async () => {
    jest.useFakeTimers();
    try {
      const net = amazon(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            // Rejects only when aborted, like a real fetch whose server never answers.
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const h = harness({ fetch: net });
      const pending = h.service.handle(confirmation());
      await jest.advanceTimersByTimeAsync(5_001);
      await expect(pending).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['a server error', () => new Response('nope', { status: 500 }), 'http_500'],
    [
      'a 200 that is not a ConfirmSubscriptionResponse',
      () => new Response('<html/>'),
      'unexpected_response',
    ],
    [
      "a SubscriptionArn for somebody else's topic",
      () => new Response(confirmSubscriptionResponse(OTHER_TOPIC)),
      'unexpected_response',
    ],
    ['a network failure', () => Promise.reject(new Error('ECONNRESET')), 'network_error'],
  ])('reports %s as failed and leaves the row retryable', async (_label, respond, reason) => {
    const h = harness({ fetch: amazon(respond as () => Response) });
    await expect(h.service.handle(confirmation())).resolves.toEqual({ kind: 'failed', reason });
    const row = h.prisma.rows[0];
    expect(row.status).toBe('PENDING');
    expect(row.lastFailure).toBe(reason);
    expect(row.lastAttemptAt).toBeNull();
    expect(h.audits[0]).toMatchObject({ action: 'SNS_SUBSCRIPTION_CONFIRM_FAILED' });
  });

  it("succeeds on SNS's redelivery after a failure", async () => {
    let n = 0;
    const net = amazon(() =>
      ++n === 1
        ? new Response('busy', { status: 503 })
        : new Response(confirmSubscriptionResponse(TOPIC), { status: 200 }),
    );
    const h = harness({ fetch: net });
    await expect(h.service.handle(confirmation())).resolves.toMatchObject({ kind: 'failed' });
    await expect(h.service.handle(confirmation())).resolves.toEqual({ kind: 'confirmed' });
    expect(net.calls).toHaveLength(2);
    expect(h.prisma.rows).toHaveLength(1);
    expect(h.prisma.rows[0]).toMatchObject({ status: 'CONFIRMED', attemptCount: 2 });
  });
});

describe('the status an operator reads', () => {
  it('never includes the URL, token or SubscriptionArn', async () => {
    const h = harness({});
    await h.service.handle(confirmation());
    const status = await h.service.status();
    expect(status).toMatchObject({ topicArn: TOPIC, status: 'CONFIRMED', attemptCount: 1 });
    const text = JSON.stringify(status);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Action=');
    expect(text).not.toContain(`${TOPIC}:`);
  });
});
