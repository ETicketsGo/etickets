import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';

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
  } = {},
) {
  const deliver = opts.deliver ?? jest.fn().mockResolvedValue(undefined);

  let seq = 0;
  const prisma = {
    notification: {
      create: jest.fn().mockImplementation(({ data }) => {
        seq += 1;
        return Promise.resolve({ id: `created-${seq}`, ...data });
      }),
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
  const service = new NotificationService(
    prisma as never,
    templates as never,
    preferences as never,
    channels as never,
  );
  return { service, prisma, templates, preferences, channels, deliver };
}

describe('NotificationService.send (backward compatibility)', () => {
  it('default (no channels/locale) persists an email + in_app SENT row and delivers to each', async () => {
    const { service, prisma, deliver } = setup();

    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      toEmail: 'a@b.test',
      payload: { bookingId: 'bk-1', tickets: 2 },
    });

    // Default channels are email + in_app (the latter feeds the in-app inbox).
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: NotificationType.BOOKING_CONFIRMED,
          channel: 'email',
          locale: 'en',
          status: 'SENT',
          sentAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channel: 'in_app', status: 'SENT' }),
      }),
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('fans out to each requested channel when channels are given', async () => {
    const { service, prisma, deliver } = setup();
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      payload: {},
      channels: ['email', 'sms', 'push'],
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('respects preferences: a disabled channel is not persisted or delivered', async () => {
    const { service, prisma, deliver } = setup({ disabledChannels: ['sms'] });
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      payload: {},
      channels: ['email', 'sms'],
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
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
        channels: ['email', 'sms'],
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
