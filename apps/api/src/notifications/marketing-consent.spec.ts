import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';
import { MESSAGE_CLASS, isTransactional, messageClassOf } from './message-class';

/**
 * Transactional and commercial messages are treated differently, in the product rather
 * than merely in intent.
 *
 * Two failures are being guarded against, and they point in opposite directions:
 *
 *   1. A ticket suppressed because somebody opted out of marketing. That is a product
 *      failure wearing a legal precaution as a disguise — the customer paid and got
 *      nothing, and the reason looks defensible in a code review.
 *   2. A promotional message sent to somebody with no consent on file. That is the
 *      failure anti-spam law exists to punish, and it is one default value away.
 */

function setup(opts: { consentGranted?: boolean } = {}) {
  const deliver = jest.fn().mockResolvedValue(undefined);
  const channels = {
    has: (c: string) => ['email', 'in_app', 'push'].includes(c),
    resolve: () => ({ deliver }),
  };
  const prisma = {
    // Every send now reads the recipient's stored language before rendering.
    user: { findUnique: jest.fn().mockResolvedValue({ locale: null }) },
    notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
  const templates = { render: () => ({ subject: 's', body: 'b' }) };
  // Preferences leave everything on, so anything suppressed below was suppressed by the
  // consent rule and not by a preference.
  const preferences = { resolveChannels: jest.fn(async (_u, _t, req: string[]) => req) };
  const mayReceiveMarketing = jest.fn().mockResolvedValue(opts.consentGranted ?? false);
  const service = new NotificationService(
    prisma as never,
    templates as never,
    preferences as never,
    channels as never,
    { mayReceiveMarketing } as never,
  );
  return { service, deliver, mayReceiveMarketing, prisma };
}

describe('message classification', () => {
  it('classifies every notification type the platform can send', () => {
    // The map is `Record<NotificationType, MessageClass>`, so this is really asserting
    // that the compile-time exhaustiveness has not been loosened to a partial record.
    // Collected into a list so a failure names the unclassified type rather than just
    // reporting "expected defined". (Jest's expect takes no message argument.)
    const unclassified = Object.values(NotificationType).filter((t) => !MESSAGE_CLASS[t]);
    expect(unclassified).toEqual([]);
  });

  it('treats an unknown type as commercial, not transactional', () => {
    // "We do not know what this message is" must not read as "send it to everyone".
    expect(messageClassOf('SOMETHING_ADDED_LATER' as NotificationType)).toBe('MARKETING');
    expect(isTransactional('SOMETHING_ADDED_LATER' as NotificationType)).toBe(false);
  });

  it.each([
    NotificationType.BOOKING_CONFIRMED,
    NotificationType.REFUND_COMPLETED,
    NotificationType.BOOKING_CANCELLED,
    NotificationType.PAYMENT_FAILED,
  ])('%s is transactional', (type) => {
    expect(isTransactional(type)).toBe(true);
  });
});

describe('NotificationService consent enforcement', () => {
  /*
    ── WHAT IS COUNTED, AND WHY IT CHANGED ──────────────────────────────────────────────
    These used to count calls to `deliver`, because `send` delivered. It now hands over to
    the worker instead, so the observable fact is whether a row was WRITTEN — which is the
    better assertion anyway: a suppressed commercial message must leave no trace queued for
    later, not merely go undelivered this instant.
  */
  it('queues a ticket even though no marketing consent exists', async () => {
    const { service, prisma, mayReceiveMarketing } = setup({ consentGranted: false });
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u1',
      toEmail: 'buyer@example.test',
      payload: {},
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);
    // Not merely "it was allowed" — the consent store was never even asked. A
    // transactional message must not become dependent on a consent lookup that could
    // later fail, time out, or be misconfigured.
    expect(mayReceiveMarketing).not.toHaveBeenCalled();
  });

  it('queues nothing commercial when no consent is on file', async () => {
    const { service, prisma, mayReceiveMarketing } = setup({ consentGranted: false });
    await service.send({
      type: 'PROMOTIONAL_BLAST' as NotificationType,
      userId: 'u1',
      toEmail: 'buyer@example.test',
      payload: {},
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(mayReceiveMarketing).toHaveBeenCalled();
  });

  it('queues a commercial message once consent is recorded', async () => {
    const { service, prisma } = setup({ consentGranted: true });
    await service.send({
      type: 'PROMOTIONAL_BLAST' as NotificationType,
      userId: 'u1',
      toEmail: 'buyer@example.test',
      payload: {},
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);
  });

  it('asks per channel, so consenting to email does not consent to push', async () => {
    const deliver = jest.fn().mockResolvedValue({ provider: 'log' });
    const channels = {
      has: (c: string) => ['email', 'in_app', 'push'].includes(c),
      resolve: () => ({ deliver }),
    };
    const mayReceiveMarketing = jest.fn(
      async (_s: unknown, channel: string) => channel === 'email',
    );
    const create = jest.fn().mockResolvedValue({ id: 'n' });
    const service = new NotificationService(
      {
        user: { findUnique: jest.fn().mockResolvedValue({ locale: null }) },
        notification: { create },
      } as never,
      { render: () => ({ subject: 's', body: 'b' }) } as never,
      { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
      channels as never,
      { mayReceiveMarketing } as never,
    );
    await service.send({
      type: 'PROMOTIONAL_BLAST' as NotificationType,
      userId: 'u1',
      toEmail: 'buyer@example.test',
      payload: {},
    });
    // One row, for the one channel consent was given on.
    expect(create).toHaveBeenCalledTimes(1);
    expect(mayReceiveMarketing.mock.calls.map((c) => c[1]).sort()).toEqual([
      'email',
      'in_app',
      'push',
    ]);
  });

  it('writes no notification row for a suppressed commercial message', async () => {
    // Persisting a row with status SENT for a message that was never sent would make the
    // audit trail lie in exactly the direction that matters.
    const { service, prisma } = setup({ consentGranted: false });
    await service.send({
      type: 'PROMOTIONAL_BLAST' as NotificationType,
      userId: 'u1',
      toEmail: 'buyer@example.test',
      payload: {},
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});
