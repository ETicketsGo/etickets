import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationPreferencesService } from './notification-preferences.service';

function setup(prefRows: Array<{ channel: string; enabled: boolean }> = []) {
  const prisma = {
    notificationPreference: {
      findMany: jest.fn().mockResolvedValue(prefRows),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const service = new NotificationPreferencesService(prisma as never);
  return { service, prisma };
}

describe('NotificationPreferencesService.resolveChannels', () => {
  it('default: no rows means all requested channels are enabled', async () => {
    const { service } = setup([]);
    const out = await service.resolveChannels('u1', NotificationType.BOOKING_CONFIRMED, [
      'email',
      'sms',
    ]);
    expect(out).toEqual(['email', 'sms']);
  });

  it('opt-out: a disabled row removes exactly that channel', async () => {
    const { service } = setup([{ channel: 'sms', enabled: false }]);
    const out = await service.resolveChannels('u1', NotificationType.BOOKING_CONFIRMED, [
      'email',
      'sms',
    ]);
    expect(out).toEqual(['email']);
  });

  it('an enabled=true row does not remove the channel', async () => {
    const { service } = setup([{ channel: 'sms', enabled: true }]);
    const out = await service.resolveChannels('u1', NotificationType.BOOKING_CONFIRMED, [
      'email',
      'sms',
    ]);
    expect(out).toEqual(['email', 'sms']);
  });

  it('guest (null userId): requested channels pass through unchanged and no query runs', async () => {
    const { service, prisma } = setup([]);
    const out = await service.resolveChannels(null, NotificationType.BOOKING_CONFIRMED, [
      'email',
      'sms',
    ]);
    expect(out).toEqual(['email', 'sms']);
    expect(prisma.notificationPreference.findMany).not.toHaveBeenCalled();
  });
});

describe('NotificationPreferencesService.setPreference', () => {
  it('upserts on the (userId, type, channel) compound key', async () => {
    const { service, prisma } = setup([]);
    await service.setPreference('u1', NotificationType.PAYMENT_FAILED, 'email', false);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_type_channel: {
            userId: 'u1',
            type: NotificationType.PAYMENT_FAILED,
            channel: 'email',
          },
        },
        create: expect.objectContaining({ enabled: false }),
        update: { enabled: false },
      }),
    );
  });
});
