import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';
import { TransportError } from './channels/transports/transport-http';

/**
 * The dispatch loop's two new duties around a provider.
 *
 * After an acceptance: ask for any delivery callback that beat the SID into the database, so a
 * held event is applied the moment its message becomes findable rather than a sweep later.
 *
 * After a failure: keep what the provider said, minus the recipient. Text and WhatsApp adapters
 * can quote the number they refused; email is left exactly as it was.
 */

function setup(channel: 'sms' | 'email', deliver: jest.Mock) {
  const row = {
    id: 'n1',
    type: NotificationType.SHOW_CANCELLED,
    channel,
    locale: 'en',
    userId: null,
    toEmail: 'ops@example.test',
    payload: { phone: '+14155550123' },
    status: 'PENDING',
    attempts: 0,
    sendReason: null,
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
  };
  const calls: string[] = [];
  const prisma = {
    notification: {
      findMany: jest.fn().mockResolvedValue([row]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const templates = { render: jest.fn().mockReturnValue({ subject: 'S', body: 'B' }) };
  const channels = { resolve: jest.fn().mockReturnValue({ key: channel, deliver }) };
  const deliveries = {
    open: jest.fn().mockResolvedValue('d1'),
    accepted: jest.fn(async () => {
      calls.push('accepted');
    }),
    failed: jest.fn().mockResolvedValue(undefined),
    skipped: jest.fn().mockResolvedValue(undefined),
  };
  const replay = {
    reapplyFor: jest.fn(async () => {
      calls.push('reapplyFor');
      return 0;
    }),
  };
  const service = new NotificationService(
    prisma as never,
    templates as never,
    {} as never,
    channels as never,
    {} as never,
    undefined,
    deliveries as never,
    undefined,
    undefined,
    replay as never,
  );
  return { service, prisma, deliveries, replay, calls };
}

describe('dispatch: after a provider accepts', () => {
  it('asks for callbacks that arrived early, once the SID is recorded and not before', async () => {
    const deliver = jest.fn().mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM1' });
    const { service, replay, calls } = setup('sms', deliver);

    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));

    expect(replay.reapplyFor).toHaveBeenCalledWith('twilio', 'SM1');
    expect(calls).toEqual(['accepted', 'reapplyFor']);
  });

  it('does not ask when the provider issued no reference', async () => {
    const deliver = jest.fn().mockResolvedValue({ provider: 'log' });
    const { service, replay } = setup('sms', deliver);
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(replay.reapplyFor).not.toHaveBeenCalled();
  });

  it('never fails a send because the replay did', async () => {
    const deliver = jest.fn().mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM2' });
    const { service, replay } = setup('sms', deliver);
    replay.reapplyFor.mockRejectedValueOnce(new Error('database blip'));
    await expect(service.dispatchDue(new Date('2026-06-01T00:00:00Z'))).resolves.toMatchObject({
      sent: 1,
      failed: 0,
    });
  });
});

describe('dispatch: after a provider fails', () => {
  it('stores a text-message failure without the number, in both places it is written', async () => {
    const deliver = jest
      .fn()
      .mockRejectedValue(
        new TransportError(
          'msg91 returned HTTP 400: {"message":"Invalid mobile 14155550123"}',
          'msg91',
          FailureClass.PERMANENT_REJECTION,
          400,
        ),
      );
    const { service, prisma, deliveries } = setup('sms', deliver);

    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));

    const stored = deliveries.failed.mock.calls[0][2] as string;
    expect(stored).not.toContain('14155550123');
    expect(stored).toContain('HTTP 400');
    const lastError = (
      prisma.notification.update.mock.calls.at(-1)?.[0] as {
        data: { lastError: string };
      }
    ).data.lastError;
    expect(lastError).not.toContain('14155550123');
  });

  it('leaves an email failure exactly as the provider wrote it', async () => {
    const text = 'ses returned HTTP 400: Email address is not verified: ops@example.test';
    const deliver = jest
      .fn()
      .mockRejectedValue(new TransportError(text, 'ses', FailureClass.PERMANENT_REJECTION, 400));
    const { service, deliveries } = setup('email', deliver);

    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));

    expect(deliveries.failed.mock.calls[0][2]).toBe(text);
  });
});
