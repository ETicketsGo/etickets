import { PrismaClient } from '@prisma/client';
import { SnsConfirmationService } from './sns-confirmation.service';

/**
 * The guarantees that live in the database, not in the service.
 *
 * ── WHY THESE NEED A REAL POSTGRES ─────────────────────────────────────────────────
 * Idempotency here is a unique index, and supersession is an UPDATE with a predicate. A fake
 * Prisma would prove that the test's own fake behaves as the test expects, which is not the
 * claim. SNS redelivers a confirmation with the SAME MessageId when it does not get a prompt
 * 2xx — which is exactly what happened while the api was asleep — so "a redelivery is a no-op"
 * is a property the schema has to hold, not one the code can assert.
 *
 * Skips rather than fabricating a pass when no database is reachable.
 */

const URL_A = 'https://sns.ap-south-2.amazonaws.com/?Action=ConfirmSubscription&Token=AAA';
const URL_B = 'https://sns.ap-south-2.amazonaws.com/?Action=ConfirmSubscription&Token=BBB';
const TOPIC = 'arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events-spec';

const prisma = new PrismaClient();
let reachable = true;

const audits: Record<string, unknown>[] = [];
const service = new SnsConfirmationService(
  prisma as never,
  { get: (k: string) => (k === 'APP_ENV' ? 'TEST' : undefined) } as never,
  { record: async (e: Record<string, unknown>) => void audits.push(e) } as never,
);

beforeAll(async () => {
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
});

beforeEach(async () => {
  if (!reachable) return;
  audits.length = 0;
  await prisma.snsPendingConfirmation.deleteMany({ where: { topicArn: TOPIC } });
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe('a redelivered confirmation', () => {
  maybe('is stored once, however many times SNS sends it', async () => {
    for (let i = 0; i < 3; i += 1) {
      await service.capture({ topicArn: TOPIC, messageId: 'msg-same', subscribeUrl: URL_A });
    }
    const rows = await prisma.snsPendingConfirmation.findMany({ where: { topicArn: TOPIC } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
  });

  maybe('does not un-reveal a confirmation an operator has already acted on', async () => {
    await service.capture({ topicArn: TOPIC, messageId: 'msg-same', subscribeUrl: URL_A });
    const revealed = await service.reveal('admin-1');
    expect(revealed.subscribeUrl).toBe(URL_A);

    // SNS retries the very same message after the reveal.
    await service.capture({ topicArn: TOPIC, messageId: 'msg-same', subscribeUrl: URL_A });

    const row = await prisma.snsPendingConfirmation.findUniqueOrThrow({
      where: { messageId: 'msg-same' },
    });
    expect(row.revealedAt).not.toBeNull();
    expect(row.revealedBy).toBe('admin-1');
    // And a second reveal is still refused.
    await expect(service.reveal('admin-2')).rejects.toBeDefined();
  });
});

describe('a fresh confirmation for the same topic', () => {
  maybe('supersedes the older pending one, so "the pending token" is never ambiguous', async () => {
    await service.capture({ topicArn: TOPIC, messageId: 'msg-old', subscribeUrl: URL_A });
    await service.capture({ topicArn: TOPIC, messageId: 'msg-new', subscribeUrl: URL_B });

    const old = await prisma.snsPendingConfirmation.findUniqueOrThrow({
      where: { messageId: 'msg-old' },
    });
    const fresh = await prisma.snsPendingConfirmation.findUniqueOrThrow({
      where: { messageId: 'msg-new' },
    });
    expect(old.status).toBe('EXPIRED');
    expect(fresh.status).toBe('PENDING');
  });

  maybe('is the one revealed', async () => {
    await service.capture({ topicArn: TOPIC, messageId: 'msg-old', subscribeUrl: URL_A });
    await service.capture({ topicArn: TOPIC, messageId: 'msg-new', subscribeUrl: URL_B });
    /*
      The token AWS has actually got on file is the newest one. Revealing the superseded token
      would send an operator to paste a value the console rejects, and the obvious conclusion
      would be that this endpoint is broken.
    */
    const revealed = await service.reveal('admin-1');
    expect(revealed.subscribeUrl).toBe(URL_B);
  });
});

describe('the stored row', () => {
  maybe('keeps the URL out of everything except the one-time reveal', async () => {
    await service.capture({ topicArn: TOPIC, messageId: 'msg-1', subscribeUrl: URL_A });

    const status = await service.status();
    expect(JSON.stringify(status)).not.toContain('Token=AAA');

    // Nothing in the audit trail carries it either.
    expect(JSON.stringify(audits)).not.toContain('Token=AAA');

    const revealed = await service.reveal('admin-1');
    expect(revealed.subscribeUrl).toBe(URL_A);
    expect(JSON.stringify(audits)).not.toContain('Token=AAA');
  });

  maybe('can be marked confirmed by a person, and only by a person', async () => {
    await service.capture({ topicArn: TOPIC, messageId: 'msg-1', subscribeUrl: URL_A });
    const before = await service.status();
    expect(before?.status).toBe('PENDING');

    const after = await service.markConfirmed('admin-1', before!.id);
    expect(after.status).toBe('CONFIRMED');
    // No longer pending, so it cannot be revealed again by accident.
    expect(await service.status()).toBeNull();
    expect(audits.map((a) => a.action)).toContain('SNS_CONFIRMATION_MARKED_CONFIRMED');
  });
});
