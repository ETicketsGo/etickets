import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';
import { TransportError } from './channels/transports/transport-http';

/**
 * A provider outage must not be able to fail a payment, and a row must not claim a send that
 * never happened.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * `send()` used to write `status: 'SENT'` and then deliver, inline and unguarded, in the
 * caller's request. Two of the sixteen callers do that immediately after money has moved:
 * PaymentsService once a payment is captured and a booking confirmed, RefundsService once a
 * refund has completed and a credit note has been issued. So an SES timeout would unwind
 * through a path whose work had ALREADY COMMITTED — customer charged, booking confirmed,
 * request returns an error — and the database would meanwhile record the confirmation as
 * successfully sent. The only reason it never happened in production is that the configured
 * provider has always been `log`, which cannot fail.
 */

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);

function setup(opts: { deliver?: jest.Mock; dueRows?: Record<string, unknown>[] } = {}) {
  const deliver = opts.deliver ?? jest.fn().mockResolvedValue({ provider: 'log' });
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    // The sweep runs inside a transaction that holds its single-flight advisory lock.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) }),
    ),
    user: { findUnique: jest.fn().mockResolvedValue({ locale: null }) },
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      // Dedupable types insert through createMany + skipDuplicates: a unique violation
      // raised mid-statement would abort the caller's whole transaction, taking the
      // domain change with it. `ON CONFLICT DO NOTHING` never raises.
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'created-1' }),
      findMany: jest.fn().mockResolvedValue(opts.dueRows ?? []),
      update,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new NotificationService(
    prisma as never,
    { render: () => ({ subject: 'S', body: 'B' }) } as never,
    { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
    {
      has: (c: string) => KNOWN.has(c),
      resolve: (c: string) => (KNOWN.has(c) ? { key: c, deliver } : undefined),
    } as never,
    { mayReceiveMarketing: jest.fn().mockResolvedValue(false) } as never,
  );
  return { service, prisma, deliver, update };
}

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    type: NotificationType.BOOKING_CONFIRMED,
    channel: 'email',
    locale: 'en',
    userId: 'u1',
    toEmail: 'buyer@example.test',
    payload: { bookingId: 'bk-1' },
    status: 'PENDING',
    attempts: 0,
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('a provider cannot fail the caller', () => {
  it('send() resolves even when every channel would throw', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('SES is down'));
    const { service } = setup({ deliver });

    // This is the assertion the payment path depends on.
    await expect(
      service.send({
        type: NotificationType.BOOKING_CONFIRMED,
        userId: 'u1',
        toEmail: 'buyer@example.test',
        payload: { bookingId: 'bk-1' },
      }),
    ).resolves.toBeUndefined();

    // And it resolves because nothing was attempted, not because something was swallowed.
    // A caught-and-logged exception would still have cost the caller the provider's timeout.
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a slow provider costs the caller nothing, because it is not called', async () => {
    const deliver = jest.fn().mockImplementation(() => new Promise(() => undefined));
    const { service } = setup({ deliver });
    await expect(
      service.send({ type: NotificationType.REFUND_COMPLETED, userId: 'u1', payload: {} }),
    ).resolves.toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('writes the message down before handing over, so it is not lost', async () => {
    const { service, prisma } = setup({
      deliver: jest.fn().mockRejectedValue(new Error('down')),
    });
    await service.send({ type: NotificationType.BOOKING_CONFIRMED, userId: 'u1', payload: {} });
    // Durable, and PENDING: the worker will pick it up and keep trying.
    expect(prisma.notification.create).toHaveBeenCalled();
    expect(prisma.notification.create.mock.calls[0][0].data.status).toBe('PENDING');
  });

  it('can enqueue inside the caller transaction, so a commit carries the message with it', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'n1' });
    const { service, prisma } = setup();
    await service.send({ type: NotificationType.BOOKING_CONFIRMED, userId: 'u1', payload: {} }, {
      notification: { create },
    } as never);
    expect(create).toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('the status column tells the truth', () => {
  it('PENDING becomes SENT only after a provider accepted, and records which one', async () => {
    const deliver = jest
      .fn()
      .mockResolvedValue({ provider: 'ses', providerMessageId: 'ses-msg-1' });
    const { service, update } = setup({ deliver, dueRows: [dueRow()] });

    const summary = await service.dispatchDue();

    expect(summary).toMatchObject({ sent: 1, failed: 0, retried: 0 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n1' },
        data: expect.objectContaining({
          status: 'SENT',
          provider: 'ses',
          providerMessageId: 'ses-msg-1',
          sentAt: expect.any(Date),
        }),
      }),
    );
  });

  it('a skip is recorded with its reason, not as a bare success', async () => {
    // Nothing was delivered — there was nowhere to deliver to. Retrying cannot change that,
    // so it is terminal, but an operator reading the row must see WHY it was empty.
    const deliver = jest
      .fn()
      .mockResolvedValue({ provider: 'none', skipped: true, reason: 'no_destination' });
    const { service, update } = setup({ deliver, dueRows: [dueRow({ channel: 'sms' })] });

    await service.dispatchDue();

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'SENT',
      lastError: 'no_destination',
    });
  });

  it('a transient failure stays queued and retries', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service, update } = setup({ deliver, dueRows: [dueRow({ attempts: 0 })] });

    const summary = await service.dispatchDue();

    expect(summary).toMatchObject({ sent: 0, failed: 0, retried: 1 });
    expect(update.mock.calls[0][0].data).toMatchObject({ attempts: 1, status: 'PENDING' });
    // Queued for LATER, not for the next five-second sweep.
    expect(update.mock.calls[0][0].data.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after the attempt limit', async () => {
    /*
      Six attempts spread over about four hours, not three inside ten seconds: a provider blip
      shorter than the retry ladder must not be able to fail a ticket email for good.
    */
    const deliver = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service, update } = setup({ deliver, dueRows: [dueRow({ attempts: 5 })] });

    const summary = await service.dispatchDue();

    expect(summary).toMatchObject({ failed: 1 });
    expect(update.mock.calls[0][0].data).toMatchObject({ attempts: 6, status: 'FAILED' });
  });

  it('believes a permanent refusal the first time', async () => {
    /*
      "No DLT template for this type" and "no provider route for this destination" will be
      just as true in an hour. Burning twelve retries on them only delays the moment somebody
      sees a FAILED row naming the configuration that is missing.
    */
    const deliver = jest
      .fn()
      .mockRejectedValue(
        new TransportError('no template configured', 'msg91', FailureClass.TEMPLATE_NOT_FOUND),
      );
    const { service, update } = setup({ deliver, dueRows: [dueRow({ channel: 'sms' })] });

    const summary = await service.dispatchDue();

    expect(summary).toMatchObject({ failed: 1, retried: 0 });
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'no template configured',
    });
  });

  it('sweeps immediate and scheduled work together', async () => {
    const { service, prisma } = setup({ dueRows: [] });
    await service.dispatchDue(new Date('2026-05-05T00:00:00Z'));
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PENDING', 'SCHEDULED'] } }),
      }),
    );
  });
});
