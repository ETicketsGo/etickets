import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SnsVerifier, type SnsEnvelope } from './sns-verifier';
import { SnsConfirmationService } from './sns-confirmation.service';
import { confirmSubscriptionResponse, snsSubscribeUrl } from '../../test-support/sns-signing';

/**
 * The confirmation guarantees that live in the database, not in the service.
 *
 * ── WHY THESE NEED A REAL POSTGRES ─────────────────────────────────────────────────
 * "A repeat is a no-op" is a unique index on (topicArn, tokenHash) plus one on MessageId, and
 * "only one request calls Amazon" is an UPDATE with a predicate. A fake Prisma would prove
 * only that the test's own fake behaves as the test expects. SNS redelivers a confirmation
 * with the SAME MessageId when it does not get a prompt 2xx, sometimes while the first
 * delivery is still in flight, so both properties have to hold under the real engine.
 *
 * Skips rather than fabricating a pass when no database is reachable.
 */

const SUFFIX = `${Date.now()}`;
const TOPIC = `arn:aws:sns:ap-south-1:668506406280:sns-confirm-spec-${SUFFIX}`;
const TOKEN_A = `aaaa${SUFFIX}`.padEnd(64, 'a');
const TOKEN_B = `bbbb${SUFFIX}`.padEnd(64, 'b');

const prisma = new PrismaClient();
let reachable = true;

const calls: string[] = [];
let respond: () => Promise<Response> = async () =>
  new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
const fetchImpl = (async (url: unknown) => {
  calls.push(String(url));
  return respond();
}) as unknown as typeof fetch;

const audits: Record<string, unknown>[] = [];
const values: Record<string, string> = { APP_ENV: 'PRODUCTION', SES_SNS_TOPIC_ARNS: TOPIC };
const configService = { get: (k: string) => values[k] };
const service = new SnsConfirmationService(
  prisma as never,
  configService as never,
  { record: async (e: Record<string, unknown>) => void audits.push(e) } as never,
  new SnsVerifier(undefined, configService as never),
  fetchImpl,
);

function confirmation(token: string, messageId: string): SnsEnvelope {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: `${messageId}-${SUFFIX}`,
    TopicArn: TOPIC,
    Token: token,
    SubscribeURL: snsSubscribeUrl(TOPIC, token),
    Message: 'You have chosen to subscribe to the topic.',
    Timestamp: '2026-10-20T10:00:00.000Z',
    SignatureVersion: '1',
  };
}

beforeAll(async () => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    reachable = false;
    // eslint-disable-next-line no-console
    console.warn('[sns-confirmation] SKIPPED — no PostgreSQL reachable');
  }
});

afterAll(async () => {
  if (reachable) {
    await prisma.snsPendingConfirmation.deleteMany({ where: { topicArn: TOPIC } });
  }
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

beforeEach(async () => {
  if (!reachable) return;
  calls.length = 0;
  audits.length = 0;
  respond = async () => new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
  await prisma.snsPendingConfirmation.deleteMany({ where: { topicArn: TOPIC } });
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe('integration-real-postgres: automatic SNS confirmation (APP_ENV=PRODUCTION)', () => {
  maybe('confirms once, and a redelivery of the same message fetches nothing', async () => {
    await expect(service.handle(confirmation(TOKEN_A, 'm1'))).resolves.toEqual({
      kind: 'confirmed',
    });
    await expect(service.handle(confirmation(TOKEN_A, 'm1'))).resolves.toEqual({
      kind: 'already_confirmed',
    });
    expect(calls).toHaveLength(1);
    const rows = await prisma.snsPendingConfirmation.findMany({ where: { topicArn: TOPIC } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CONFIRMED', attemptCount: 1, lastFailure: null });
    expect(rows[0].confirmedAt).toBeInstanceOf(Date);
  });

  maybe('never stores the token: the URL is redacted and only a hash is kept', async () => {
    await service.handle(confirmation(TOKEN_A, 'm1'));
    const row = await prisma.snsPendingConfirmation.findFirstOrThrow({
      where: { topicArn: TOPIC },
    });
    expect(JSON.stringify(row)).not.toContain(TOKEN_A);
    expect(row.subscribeUrl).toContain('Token=NOT-STORED');
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  maybe('two deliveries racing each other call Amazon once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = async () => {
      await gate;
      return new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
    };
    // Started together, so both race to create the row and to take the lease.
    const a = service.handle(confirmation(TOKEN_A, 'm1'));
    const b = service.handle(confirmation(TOKEN_A, 'm1'));
    /*
      The request that won the lease is held at Amazon until released, so whichever finishes
      first is the loser -- and it must have found the lease, not called Amazon itself.
    */
    const loser = await Promise.race([a, b]);
    expect(loser).toEqual({ kind: 'in_progress' });
    expect(calls).toHaveLength(1);
    release();
    const outcomes = (await Promise.all([a, b])).map((o) => o.kind).sort();
    expect(outcomes).toEqual(['confirmed', 'in_progress']);
    expect(calls).toHaveLength(1);
  });

  maybe('a failure leaves the row retryable, and the retry confirms it', async () => {
    respond = async () => new Response('busy', { status: 503 });
    await expect(service.handle(confirmation(TOKEN_A, 'm1'))).resolves.toEqual({
      kind: 'failed',
      reason: 'http_503',
    });
    let row = await prisma.snsPendingConfirmation.findFirstOrThrow({ where: { topicArn: TOPIC } });
    expect(row).toMatchObject({ status: 'PENDING', lastFailure: 'http_503', lastAttemptAt: null });

    respond = async () => new Response(confirmSubscriptionResponse(TOPIC), { status: 200 });
    await expect(service.handle(confirmation(TOKEN_A, 'm1'))).resolves.toEqual({
      kind: 'confirmed',
    });
    row = await prisma.snsPendingConfirmation.findFirstOrThrow({ where: { topicArn: TOPIC } });
    expect(row).toMatchObject({ status: 'CONFIRMED', attemptCount: 2, lastFailure: null });
  });

  maybe('a new token for the topic is confirmed, and supersedes an older pending row', async () => {
    // A legacy row from the retired manual flow (ADR-052), still PENDING.
    await prisma.snsPendingConfirmation.create({
      data: {
        topicArn: TOPIC,
        messageId: `legacy-${SUFFIX}`,
        subscribeUrl: 'https://sns.ap-south-1.amazonaws.com/?legacy',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await service.handle(confirmation(TOKEN_A, 'm1'));
    await expect(service.handle(confirmation(TOKEN_B, 'm2'))).resolves.toEqual({
      kind: 'confirmed',
    });
    expect(calls).toHaveLength(2);
    const legacy = await prisma.snsPendingConfirmation.findUniqueOrThrow({
      where: { messageId: `legacy-${SUFFIX}` },
    });
    expect(legacy.status).toBe('EXPIRED');
  });

  maybe('a refused message writes nothing at all', async () => {
    const bad = {
      ...confirmation(TOKEN_A, 'm1'),
      SubscribeURL: snsSubscribeUrl(TOPIC, TOKEN_A).replace('sns.ap-south-1.', 'sns.us-east-1.'),
    };
    await expect(service.handle(bad)).resolves.toMatchObject({ kind: 'refused' });
    expect(calls).toHaveLength(0);
    await expect(prisma.snsPendingConfirmation.count({ where: { topicArn: TOPIC } })).resolves.toBe(
      0,
    );
  });
});
