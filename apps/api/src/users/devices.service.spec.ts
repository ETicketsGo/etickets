import { DevicesService, maskToken } from './devices.service';
import { AppException } from '../common/errors';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrst]';

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev_1',
    userId: 'u_1',
    token: TOKEN,
    provider: 'expo',
    platform: 'android',
    appVersion: '0.1.0',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    permissionStatus: 'granted',
    disabled: false,
    lastSeenAt: new Date('2026-08-05T10:00:00.000Z'),
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

function makeService(opts: { found?: unknown; deleteCount?: number; list?: unknown[] } = {}) {
  const upsert = jest.fn().mockResolvedValue(device());
  const update = jest.fn().mockResolvedValue(device());
  const findUnique = jest.fn().mockResolvedValue(opts.found === undefined ? device() : opts.found);
  const findMany = jest.fn().mockResolvedValue(opts.list ?? [device()]);
  const deleteMany = jest.fn().mockResolvedValue({ count: opts.deleteCount ?? 1 });

  const prisma = { userDevice: { upsert, update, findUnique, findMany, deleteMany } };
  return {
    service: new DevicesService(prisma as never),
    upsert,
    update,
    findUnique,
    findMany,
    deleteMany,
  };
}

describe('registration', () => {
  it('upserts on the TOKEN so one device is one row', async () => {
    const { service, upsert } = makeService();

    await service.register('u_1', { token: TOKEN, platform: 'android' });

    // Keyed on token, not on (user, platform): re-opening the app must update one row,
    // not accumulate one per launch and send a notification per row.
    expect(upsert.mock.calls[0][0].where).toEqual({ token: TOKEN });
  });

  it('REASSIGNS a token that shows up under a different account', async () => {
    const { service, upsert } = makeService();

    await service.register('u_2', { token: TOKEN, platform: 'android' });

    // A phone signed out of A and into B keeps its token. Leaving the row on A would
    // send A's booking notifications to a phone B is holding — a privacy incident, not
    // a duplicate-delivery annoyance.
    expect(upsert.mock.calls[0][0].update.userId).toBe('u_2');
  });

  it('clears the disabled flag, because the client just proved the token is live', async () => {
    const { service, upsert } = makeService();

    await service.register('u_1', { token: TOKEN, platform: 'ios' });

    expect(upsert.mock.calls[0][0].update.disabled).toBe(false);
    expect(upsert.mock.calls[0][0].create.disabled).toBe(false);
  });

  it('defaults the provider to expo and permission to undetermined', async () => {
    const { service, upsert } = makeService();

    await service.register('u_1', { token: TOKEN, platform: 'android' });

    expect(upsert.mock.calls[0][0].create.provider).toBe('expo');
    expect(upsert.mock.calls[0][0].create.permissionStatus).toBe('undetermined');
  });

  it('records app version, locale and timezone when supplied', async () => {
    const { service, upsert } = makeService();

    await service.register('u_1', {
      token: TOKEN,
      platform: 'ios',
      appVersion: '1.2.3',
      locale: 'en-CA',
      timezone: 'America/Toronto',
      permissionStatus: 'granted',
    });

    expect(upsert.mock.calls[0][0].create).toMatchObject({
      appVersion: '1.2.3',
      locale: 'en-CA',
      timezone: 'America/Toronto',
      permissionStatus: 'granted',
    });
  });

  it('is safe to call repeatedly', async () => {
    const { service, upsert } = makeService();

    await service.register('u_1', { token: TOKEN, platform: 'android' });
    await service.register('u_1', { token: TOKEN, platform: 'android' });

    // upsert is inherently idempotent, so a retry after a dropped response is safe.
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where).toEqual(upsert.mock.calls[1][0].where);
  });
});

describe('token confidentiality', () => {
  it('never returns the full token', async () => {
    const { service } = makeService();

    const view = await service.register('u_1', { token: TOKEN, platform: 'android' });

    // A push token lets its holder notify that device. It leaves the server masked.
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.tokenPreview).toBe('…pqrst]');
  });

  it('masks a short token entirely rather than revealing most of it', () => {
    expect(maskToken('abc')).toBe('******');
    expect(maskToken('abcdef')).toBe('******');
  });

  it('never exposes a token on the list endpoint', async () => {
    const { service } = makeService({
      list: [device(), device({ id: 'dev_2', token: 'x'.repeat(40) })],
    });

    const views = await service.listMine('u_1');

    expect(JSON.stringify(views)).not.toContain(TOKEN);
    for (const view of views) expect(view).not.toHaveProperty('token');
  });
});

describe('ownership', () => {
  it('scopes the list to the caller with no widening parameter', async () => {
    const { service, findMany } = makeService();

    await service.listMine('u_1');

    expect(findMany.mock.calls[0][0].where).toEqual({ userId: 'u_1' });
  });

  it('404s when updating a device belonging to someone else', async () => {
    const { service, update } = makeService({ found: device({ userId: 'someone_else' }) });

    await expect(service.update('u_1', 'dev_1', { locale: 'en-GB' })).rejects.toBeInstanceOf(
      AppException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('404s an unknown device identically to one owned by another user', async () => {
    // A distinct 403 would confirm the existence of another user's device id.
    const { service } = makeService({ found: null });

    await expect(service.update('u_1', 'nope', {})).rejects.toBeInstanceOf(AppException);
  });

  it('deletes with the user id in the WHERE clause, not by fetch-then-check', async () => {
    const { service, deleteMany } = makeService();

    await service.remove('u_1', 'dev_1');

    // Scoping in the query removes the check-then-act race entirely.
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'dev_1', userId: 'u_1' } });
  });

  it('reports removed:false rather than erroring when nothing matched', async () => {
    const { service } = makeService({ deleteCount: 0 });

    // Idempotent logout: a retry must not be handed an error for work already done.
    expect(await service.remove('u_1', 'dev_1')).toEqual({ removed: false });
  });

  it('can deregister by token for a logout that knows the token, not the row id', async () => {
    const { service, deleteMany } = makeService();

    await service.removeByToken('u_1', TOKEN);

    expect(deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN, userId: 'u_1' } });
  });
});

describe('updates', () => {
  it('refreshes lastSeenAt on every patch', async () => {
    const { service, update } = makeService();

    await service.update('u_1', 'dev_1', { permissionStatus: 'denied' });

    expect(update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
  });

  it('records a permission that the user has since revoked', async () => {
    const { service, update } = makeService();

    await service.update('u_1', 'dev_1', { permissionStatus: 'denied' });

    // Knowing a device said no is what stops the backend queuing sends it cannot make.
    expect(update.mock.calls[0][0].data.permissionStatus).toBe('denied');
  });

  it('cannot change the token', async () => {
    const { service, update } = makeService();

    await service.update('u_1', 'dev_1', { locale: 'en-GB' } as never);

    // A new token is a new registration; a PATCH must not move a row onto a token the
    // client never proved it holds.
    expect(update.mock.calls[0][0].data).not.toHaveProperty('token');
  });
});
