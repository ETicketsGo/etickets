import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import {
  DEFAULT_DISPATCH_MAX_ATTEMPTS,
  NotificationService,
  retryDelayMs,
} from './notification.service';
import { TransportError } from './channels/transports/transport-http';

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);

interface NotifRow {
  id: string;
  type: NotificationType;
  channel: string;
  locale: string;
  userId: string | null;
  toEmail: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  scheduledFor: Date | null;
}

function row(over: Partial<NotifRow> = {}): NotifRow {
  return {
    id: 'n1',
    type: NotificationType.EVENT_REMINDER,
    channel: 'email',
    locale: 'en',
    userId: 'u1',
    toEmail: 'a@b.test',
    payload: { bookingId: 'bk-1' },
    status: 'SCHEDULED',
    attempts: 0,
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function setup(
  opts: {
    disabledChannels?: string[];
    dueRows?: NotifRow[];
    deliver?: jest.Mock;
    updateManyCount?: number;
    /** What the recipient has stored as their language; null means "never chose". */
    userLocale?: string | null;
    /** Another process already holds the dispatch sweep lock. */
    sweepLockTaken?: boolean;
  } = {},
) {
  // A channel now reports WHICH provider accepted the message, so a delivery stub must too.
  const deliver = opts.deliver ?? jest.fn().mockResolvedValue({ provider: 'log' });

  let seq = 0;
  // The advisory-lock query the sweep runs inside its transaction.
  const lockQuery = jest.fn().mockResolvedValue([{ locked: !opts.sweepLockTaken }]);
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: lockQuery }),
    ),
    /*
      The recipient's stored language. Every send reads it now — a notification goes out in
      the language the PERSON chose, not the one the calling code happened to pass, because
      thirty call sites each remembering is thirty chances to send a Quebec customer their
      confirmation in English.
    */
    user: { findUnique: jest.fn().mockResolvedValue({ locale: opts.userLocale ?? null }) },
    notification: {
      create: jest.fn().mockImplementation(({ data }) => {
        seq += 1;
        return Promise.resolve({ id: `created-${seq}`, ...data });
      }),
      // Dedupable types insert through createMany + skipDuplicates: a unique violation
      // raised mid-statement would abort the caller's whole transaction, taking the
      // domain change with it. `ON CONFLICT DO NOTHING` never raises.
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'created-1' }),
      findMany: jest.fn().mockResolvedValue(opts.dueRows ?? []),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateManyCount ?? 1 }),
    },
  };
  const templates = {
    render: jest.fn().mockReturnValue({ subject: 'S', body: 'B' }),
  };
  const preferences = {
    resolveChannels: jest
      .fn()
      .mockImplementation((_u: string | null, _t: NotificationType, requested: string[]) =>
        Promise.resolve(requested.filter((c) => !(opts.disabledChannels ?? []).includes(c))),
      ),
  };
  const channels = {
    has: jest.fn().mockImplementation((c: string) => KNOWN.has(c)),
    resolve: jest
      .fn()
      .mockImplementation((c: string) => (KNOWN.has(c) ? { key: c, deliver } : undefined)),
  };
  // Every type this suite sends is TRANSACTIONAL, so consent is never consulted; the stub
  // returns false to prove that. If a future change made a transactional message ask for
  // consent, these tests would go silent rather than pass — which is the failure worth
  // catching, so `mayReceiveMarketing` is asserted as un-called in its own test below.
  const consent = { mayReceiveMarketing: jest.fn().mockResolvedValue(false) };
  const service = new NotificationService(
    prisma as never,
    templates as never,
    preferences as never,
    channels as never,
    consent as never,
  );
  return { service, prisma, templates, preferences, channels, deliver, consent, lockQuery };
}

/**
 * The rows a send wrote, from whichever path wrote them.
 *
 * A dedupable type goes in through `createMany({ skipDuplicates })` so a collision cannot
 * abort the caller's transaction; a type with no dedupe key uses a plain `create`, which
 * cannot collide and hands back the id `schedule()` needs. Tests care about the rows, not
 * which statement produced them.
 */
function writtenRows(prisma: {
  notification: { create: jest.Mock; createMany: jest.Mock };
}): Record<string, unknown>[] {
  return [
    ...prisma.notification.create.mock.calls.map((c) => c[0].data),
    ...prisma.notification.createMany.mock.calls.flatMap((c) => c[0].data),
  ];
}

describe('NotificationService.send hands over, it does not deliver', () => {
  /*
    ── WHAT THESE REPLACED ──────────────────────────────────────────────────────────────
    They used to be titled "backward compatibility" and asserted that `send` wrote rows with
    status SENT and called `deliver` before returning. Both halves of that were the defect:
    the row claimed a successful send before anything had been attempted, and the delivery
    happened inside the caller — which for two of the sixteen callers is a request that has
    already taken somebody's money.
  */
  it('writes a PENDING row per channel and calls no provider at all', async () => {
    const { service, prisma, deliver } = setup();

    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      toEmail: 'a@b.test',
      payload: { bookingId: 'bk-1', tickets: 2 },
    });

    // Policy for a confirmed booking: email, the inbox, push, and WhatsApp.
    const rows = writtenRows(prisma);
    expect(rows).toHaveLength(4);
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: NotificationType.BOOKING_CONFIRMED,
        channel: 'email',
        locale: 'en',
        status: 'PENDING',
        scheduledFor: expect.any(Date),
      }),
    );
    // The whole point: nothing was delivered, so nothing about a provider can reach the
    // caller — not a timeout, not an outage, not a thrown error.
    expect(deliver).not.toHaveBeenCalled();
  });

  it('never writes a row claiming SENT', async () => {
    const { service, prisma } = setup();
    await service.send({ type: NotificationType.BOOKING_CONFIRMED, userId: 'u1', payload: {} });
    for (const data of writtenRows(prisma)) {
      expect(data.status).not.toBe('SENT');
      expect(data.sentAt).toBeUndefined();
    }
  });

  it('a caller may ask for fewer channels than policy allows', async () => {
    const { service, prisma } = setup();
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      payload: {},
      channels: ['email', 'push'],
    });
    expect(writtenRows(prisma)).toHaveLength(2);
  });

  it('a caller may NOT ask for a channel policy does not allow', async () => {
    /*
      This is the guard that made fixing the SMS recipient bug safe. Before it, every type
      shared one default channel list, so the moment SMS could actually reach a phone, a
      confirmed booking would have started sending one to every buyer on the platform.
    */
    const { service, prisma } = setup();
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      payload: {},
      channels: ['email', 'sms'],
    });
    expect(writtenRows(prisma)).toHaveLength(1);
    expect(writtenRows(prisma)[0]).toMatchObject({ channel: 'email' });
  });

  it('respects preferences: a disabled channel is not persisted', async () => {
    const { service, prisma } = setup({ disabledChannels: ['push'] });
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      payload: {},
      channels: ['email', 'push'],
    });
    expect(writtenRows(prisma)).toHaveLength(1);
  });
});

describe('NotificationService.schedule', () => {
  it('persists a SCHEDULED row per channel without delivering, returning ids', async () => {
    const { service, prisma, deliver } = setup();
    const when = new Date('2026-09-01T10:00:00Z');
    const ids = await service.schedule(
      {
        type: NotificationType.EVENT_REMINDER,
        userId: 'u1',
        payload: {},
        // A reminder's policy is inbox + push + WhatsApp; email is deliberately not on it,
        // and asking for it does not put it there.
        channels: ['email', 'push', 'in_app'],
      },
      when,
    );
    expect(ids).toHaveLength(2);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SCHEDULED', scheduledFor: when }),
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('NotificationService.cancel', () => {
  it('returns true when a PENDING/SCHEDULED row is cancelled', async () => {
    const { service, prisma } = setup({ updateManyCount: 1 });
    await expect(service.cancel('n1')).resolves.toBe(true);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n1', status: { in: ['PENDING', 'SCHEDULED'] } },
        data: expect.objectContaining({ status: 'CANCELLED', cancelledAt: expect.any(Date) }),
      }),
    );
  });

  it('returns false when the row is not cancellable (already SENT/FAILED/CANCELLED)', async () => {
    const { service } = setup({ updateManyCount: 0 });
    await expect(service.cancel('n1')).resolves.toBe(false);
  });
});

describe('NotificationService.dispatchDue', () => {
  it('delivers each due row and marks it SENT', async () => {
    const { service, prisma, deliver } = setup({ dueRows: [row({ id: 'd1' }), row({ id: 'd2' })] });
    const summary = await service.dispatchDue(new Date());
    expect(summary).toEqual({ sent: 2, failed: 0, retried: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
    );
  });

  it('on failure below maxAttempts: increments attempts, records error, stays SCHEDULED (retried)', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('smtp down'));
    const { service, prisma } = setup({ dueRows: [row({ id: 'd1', attempts: 0 })], deliver });
    const summary = await service.dispatchDue(new Date(), 3);
    expect(summary).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        data: expect.objectContaining({ attempts: 1, status: 'SCHEDULED', lastError: 'smtp down' }),
      }),
    );
  });

  it('on failure reaching maxAttempts: marks FAILED', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('smtp down'));
    const { service, prisma } = setup({ dueRows: [row({ id: 'd1', attempts: 2 })], deliver });
    const summary = await service.dispatchDue(new Date(), 3);
    expect(summary).toEqual({ sent: 0, failed: 1, retried: 0 });
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        data: expect.objectContaining({ attempts: 3, status: 'FAILED' }),
      }),
    );
  });
});

/**
 * Retries that outlast the outage they are retrying.
 *
 * The sweep runs every five seconds, and a retryable failure used to stay due with its original
 * `scheduledFor` -- so every attempt was spent inside about ten seconds and any provider blip
 * longer than that permanently failed the message.
 */
describe('NotificationService.dispatchDue: retry schedule', () => {
  const updateData = (prisma: { notification: { update: jest.Mock } }) =>
    prisma.notification.update.mock.calls.at(-1)?.[0].data as Record<string, unknown>;

  it('pushes a retryable failure into the future instead of leaving it due for the next sweep', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const { service, prisma } = setup({ dueRows: [row({ attempts: 0 })], deliver });

    const before = Date.now();
    await service.dispatchDue(new Date());
    const after = Date.now();

    const scheduledFor = (updateData(prisma).scheduledFor as Date).getTime();
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 60_000);
    expect(scheduledFor).toBeLessThanOrEqual(after + 60_000);
  });

  it('waits longer after each failed attempt', async () => {
    const deliver = jest
      .fn()
      .mockRejectedValue(
        new TransportError('HTTP 503', 'ses', FailureClass.TEMPORARY_PROVIDER_ERROR, 503),
      );
    const { service, prisma } = setup({ dueRows: [row({ attempts: 3 })], deliver });

    const before = Date.now();
    await service.dispatchDue(new Date());

    // The fourth failure waits an hour, not the minute the first one did.
    const delay = (updateData(prisma).scheduledFor as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(60 * 60_000);
    expect(delay).toBeLessThan(60 * 60_000 + 5_000);
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(4)).toBeLessThan(retryDelayMs(5));
  });

  it('by default keeps retrying a transient failure well past a third attempt, spread over hours', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('rate limited'));
    const { service, prisma } = setup({ dueRows: [row({ attempts: 2 })], deliver });

    await expect(service.dispatchDue(new Date())).resolves.toEqual({
      sent: 0,
      failed: 0,
      retried: 1,
    });
    expect(updateData(prisma)).toMatchObject({ attempts: 3, status: 'SCHEDULED' });

    const total = Array.from({ length: DEFAULT_DISPATCH_MAX_ATTEMPTS - 1 }, (_, i) =>
      retryDelayMs(i + 1),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(3 * 60 * 60_000);
  });

  it('marks FAILED once the default attempt limit is reached, and schedules nothing further', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('still down'));
    const { service, prisma } = setup({
      dueRows: [row({ attempts: DEFAULT_DISPATCH_MAX_ATTEMPTS - 1 })],
      deliver,
    });

    await expect(service.dispatchDue(new Date())).resolves.toMatchObject({ failed: 1 });
    expect(updateData(prisma)).toMatchObject({
      attempts: DEFAULT_DISPATCH_MAX_ATTEMPTS,
      status: 'FAILED',
    });
    expect(updateData(prisma)).not.toHaveProperty('scheduledFor');
  });

  it('fails a permanent refusal immediately, with no retry scheduled', async () => {
    const deliver = jest
      .fn()
      .mockRejectedValue(
        new TransportError('no template', 'msg91', FailureClass.TEMPLATE_NOT_FOUND),
      );
    const { service, prisma } = setup({ dueRows: [row({ channel: 'sms' })], deliver });

    await expect(service.dispatchDue(new Date())).resolves.toMatchObject({
      failed: 1,
      retried: 0,
    });
    expect(updateData(prisma)).toMatchObject({ attempts: 1, status: 'FAILED' });
    expect(updateData(prisma)).not.toHaveProperty('scheduledFor');
  });

  it('only ever selects rows that are already due', async () => {
    const { service, prisma } = setup({ dueRows: [] });
    const now = new Date('2026-05-05T00:00:00Z');
    await service.dispatchDue(now);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scheduledFor: { lte: now } }),
      }),
    );
  });
});

/**
 * One sweep at a time, across processes.
 *
 * Nothing claims a row before it is sent, so two workers overlapping during a deploy both read
 * the same PENDING row and both deliver it. The sweep is single-flight on an advisory lock.
 */
describe('NotificationService.dispatchDue: single-flight sweep', () => {
  it('skips the tick entirely when another process holds the sweep lock', async () => {
    const { service, prisma, deliver } = setup({ dueRows: [row()], sweepLockTaken: true });

    await expect(service.dispatchDue(new Date())).resolves.toEqual({
      sent: 0,
      failed: 0,
      retried: 0,
    });
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('takes a TRANSACTION-scoped lock, so a pooled connection can never leave it held', async () => {
    const { service, lockQuery, deliver } = setup({ dueRows: [row()] });

    await service.dispatchDue(new Date());

    const sql = (lockQuery.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('pg_try_advisory_xact_lock');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
