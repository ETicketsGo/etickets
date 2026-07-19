import { WebPushService } from './web-push.service';
import { LogWebPushDispatcher, type WebPushDispatcher } from './web-push.dispatcher';

function makePrisma(subs: { id: string; endpoint: string; p256dh: string; auth: string }[] = []) {
  return {
    pushSubscription: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(subs),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
}

const config = {
  get: (k: string) => (k === 'VAPID_PUBLIC_KEY' ? 'BPUBLICKEY' : undefined),
} as never;

describe('WebPushService', () => {
  it('exposes the configured VAPID public key', () => {
    const svc = new WebPushService(makePrisma() as never, config, new LogWebPushDispatcher());
    expect(svc.vapidPublicKey()).toBe('BPUBLICKEY');
  });

  it('upserts a subscription on the endpoint key', async () => {
    const prisma = makePrisma();
    const svc = new WebPushService(prisma as never, config, new LogWebPushDispatcher());
    await svc.subscribe('u1', { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } });
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { endpoint: 'https://push/1' } }),
    );
  });

  it('dispatches to each subscription and counts deliveries', async () => {
    const prisma = makePrisma([
      { id: 's1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
      { id: 's2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
    ]);
    const svc = new WebPushService(prisma as never, config, new LogWebPushDispatcher());
    const delivered = await svc.dispatchToUser('u1', { title: 'Hi', body: 'There' });
    expect(delivered).toBe(2);
  });

  it('prunes a subscription the transport reports as gone', async () => {
    const prisma = makePrisma([{ id: 's1', endpoint: 'e1', p256dh: 'p', auth: 'a' }]);
    const goneDispatcher: WebPushDispatcher = {
      name: 'gone',
      send: async () => ({ ok: false, gone: true }),
    };
    const svc = new WebPushService(prisma as never, config, goneDispatcher);
    const delivered = await svc.dispatchToUser('u1', { title: 'Hi', body: 'There' });
    expect(delivered).toBe(0);
    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('returns 0 when the user has no subscriptions', async () => {
    const svc = new WebPushService(makePrisma() as never, config, new LogWebPushDispatcher());
    expect(await svc.dispatchToUser('u1', { title: 'x', body: 'y' })).toBe(0);
  });
});
