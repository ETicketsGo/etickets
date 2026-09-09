import { Logger } from '@nestjs/common';
import { snsCaptureVerdict } from './sns-confirmation.guard';
import { SnsConfirmationService } from './sns-confirmation.service';

/**
 * Holding an SNS confirmation token, and the two things that must never happen.
 *
 * The token authorises attaching this platform's webhook to an AWS topic. It is held at all
 * only because the manual-confirmation design is otherwise impossible for a human to complete.
 * Everything below is about the boundaries of that exception: never in production, never in a
 * log, never twice.
 */

const URL_WITH_TOKEN =
  'https://sns.ap-south-2.amazonaws.com/?Action=ConfirmSubscription' +
  '&TopicArn=arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events&Token=SECRET-TOKEN-VALUE-12345';

function harness(appEnv: string | undefined, row: Record<string, unknown> | null = null) {
  const rows: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  let current = row;

  const prisma = {
    snsPendingConfirmation: {
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        rows.push(create);
        return { id: 'row-1' };
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => current),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = current ? { ...current, ...data } : null;
        return current;
      }),
    },
  };
  const audit = { record: jest.fn(async (e: Record<string, unknown>) => void audits.push(e)) };
  const config = { get: (k: string) => (k === 'APP_ENV' ? appEnv : undefined) };

  const service = new SnsConfirmationService(prisma as never, config as never, audit as never);
  return { service, prisma, audit, rows, audits, setRow: (r: typeof row) => (current = r) };
}

function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    topicArn: 'arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events',
    messageId: 'msg-1',
    subscribeUrl: URL_WITH_TOKEN,
    status: 'PENDING',
    receivedAt: new Date('2026-09-09T10:00:00Z'),
    expiresAt: new Date('2026-09-12T10:00:00Z'),
    revealedAt: null,
    revealedBy: null,
    ...over,
  };
}

const INSIDE = new Date('2026-09-09T12:00:00Z');

describe('where a confirmation token may be held', () => {
  it.each(['PRODUCTION', 'PROD', 'STAGING'])('refuses %s', (env) => {
    expect(snsCaptureVerdict(env).allowed).toBe(false);
  });

  it.each(['LOCAL', 'DEV', 'TEST', 'CI', 'QA', 'UAT'])('permits %s', (env) => {
    expect(snsCaptureVerdict(env).allowed).toBe(true);
  });

  it('refuses an unset APP_ENV rather than assuming it is safe', () => {
    // Fail closed: an unset variable is not a named non-production environment.
    expect(snsCaptureVerdict(undefined).allowed).toBe(false);
    expect(snsCaptureVerdict('').allowed).toBe(false);
  });

  it('refuses an environment nobody has thought about', () => {
    // The allowlist is the point — a new name must be added deliberately, not default to open.
    expect(snsCaptureVerdict('SANDBOX').allowed).toBe(false);
    expect(snsCaptureVerdict('preprod').allowed).toBe(false);
  });

  it('is case- and whitespace-insensitive, so a stray value cannot slip through as unrecognised', () => {
    expect(snsCaptureVerdict('  production ').allowed).toBe(false);
    expect(snsCaptureVerdict(' qa ').allowed).toBe(true);
  });
});

describe('production', () => {
  it('stores nothing, even for a message that passed signature verification', async () => {
    const { service, prisma } = harness('PRODUCTION');
    await service.capture({
      topicArn: 'arn:topic',
      messageId: 'msg-1',
      subscribeUrl: URL_WITH_TOKEN,
    });
    expect(prisma.snsPendingConfirmation.upsert).not.toHaveBeenCalled();
  });

  it('refuses to report status', async () => {
    const { service } = harness('PRODUCTION');
    await expect(service.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to reveal', async () => {
    const { service } = harness('PRODUCTION', pending());
    await expect(service.reveal('admin-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses even when APP_ENV is unset, which is the likeliest misconfiguration', async () => {
    const { service, prisma } = harness(undefined);
    await service.capture({ topicArn: 'a', messageId: 'm', subscribeUrl: URL_WITH_TOKEN });
    expect(prisma.snsPendingConfirmation.upsert).not.toHaveBeenCalled();
    await expect(service.reveal('admin-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('capture in QA', () => {
  it('stores the URL and an expiry', async () => {
    const { service, rows } = harness('QA');
    await service.capture({
      topicArn: 'arn:topic',
      messageId: 'msg-1',
      subscribeUrl: URL_WITH_TOKEN,
      now: INSIDE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topicArn: 'arn:topic', subscribeUrl: URL_WITH_TOKEN });
    // Three days, which is how long AWS honours the token.
    expect((rows[0].expiresAt as Date).toISOString()).toBe('2026-09-12T12:00:00.000Z');
  });

  it('stores nothing when the envelope lacks the fields that make it useful', async () => {
    const { service, prisma } = harness('QA');
    await service.capture({ topicArn: undefined, messageId: 'm', subscribeUrl: URL_WITH_TOKEN });
    await service.capture({ topicArn: 'a', messageId: undefined, subscribeUrl: URL_WITH_TOKEN });
    await service.capture({ topicArn: 'a', messageId: 'm', subscribeUrl: undefined });
    expect(prisma.snsPendingConfirmation.upsert).not.toHaveBeenCalled();
  });

  it('audits the capture with the topic, and never the URL', async () => {
    const { service, audits } = harness('QA');
    await service.capture({ topicArn: 'arn:topic', messageId: 'm', subscribeUrl: URL_WITH_TOKEN });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain('SECRET-TOKEN-VALUE-12345');
  });
});

describe('revealing', () => {
  it('returns the URL the first time', async () => {
    const { service } = harness('QA', pending());
    const out = await service.reveal('admin-1', INSIDE);
    expect(out.subscribeUrl).toBe(URL_WITH_TOKEN);
  });

  it('refuses the second time, and says so rather than silently returning nothing', async () => {
    const { service } = harness('QA', pending({ revealedAt: new Date('2026-09-09T11:00:00Z') }));
    await expect(service.reveal('admin-2', INSIDE)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('audits a refused second attempt, so a repeat read is visible', async () => {
    const { service, audits } = harness(
      'QA',
      pending({ revealedAt: new Date('2026-09-09T11:00:00Z') }),
    );
    await expect(service.reveal('admin-2', INSIDE)).rejects.toBeDefined();
    expect(audits.map((a) => a.action)).toContain('SNS_CONFIRMATION_REVEAL_REFUSED');
  });

  it('audits the reveal with the actor and topic, and never the URL', async () => {
    const { service, audits } = harness('QA', pending());
    await service.reveal('admin-1', INSIDE);
    const entry = audits.find((a) => a.action === 'SNS_CONFIRMATION_REVEALED');
    expect(entry).toMatchObject({ actorUserId: 'admin-1' });
    expect(JSON.stringify(entry)).not.toContain('SECRET-TOKEN-VALUE-12345');
  });

  it('refuses an expired token and explains how to get a fresh one', async () => {
    const { service } = harness('QA', pending({ expiresAt: new Date('2026-09-09T11:00:00Z') }));
    await expect(service.reveal('admin-1', INSIDE)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('says nothing is pending rather than inventing a row', async () => {
    const { service } = harness('QA', null);
    await expect(service.reveal('admin-1', INSIDE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('never returns the URL from the status route', async () => {
    const { service } = harness('QA', pending());
    const status = await service.status(INSIDE);
    expect(JSON.stringify(status)).not.toContain('SECRET-TOKEN-VALUE-12345');
    expect(status).not.toHaveProperty('subscribeUrl');
  });
});

describe('the token never reaches a log', () => {
  /**
   * ── WHY THIS TEST IS THE POINT OF THE WHOLE DESIGN ─────────────────────────────────
   * The row exists because a token in a log is a token in every aggregator, backup and
   * screenshot thereafter. A future edit that helpfully logs the URL "for debugging" would
   * undo the entire reason this table was built, and would look perfectly reasonable in review.
   */
  it('logs neither the URL nor the token, on capture or reveal', async () => {
    const written: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    );
    try {
      const { service } = harness('QA', pending());
      await service.capture({
        topicArn: 'arn:topic',
        messageId: 'm',
        subscribeUrl: URL_WITH_TOKEN,
      });
      await service.reveal('admin-1', INSIDE);

      const all = written.join('\n');
      expect(written.length).toBeGreaterThan(0); // else this asserts nothing
      expect(all).not.toContain('SECRET-TOKEN-VALUE-12345');
      expect(all).not.toContain(URL_WITH_TOKEN);
      expect(all).not.toContain('Token=');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('logs the refusal reason in production without any token in hand', async () => {
    const written: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(' ')));
    try {
      const { service } = harness('PRODUCTION');
      await service.capture({ topicArn: 'a', messageId: 'm', subscribeUrl: URL_WITH_TOKEN });
      expect(written.join('\n')).toContain('APP_ENV=PRODUCTION');
      expect(written.join('\n')).not.toContain('SECRET-TOKEN-VALUE-12345');
    } finally {
      spy.mockRestore();
    }
  });
});
